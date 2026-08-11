#!/usr/bin/env bash
# Acceptance harness for the Work Queue blog post (docs/specs/blog-workqueue-post.md).
#
# Spins a throwaway redis:8.8-alpine on port ${BLOG_WQ_PORT:-6398}, replays the
# verify-marked redis-cli blocks of index.md phase by phase, runs the six language
# workers (twice each: alone, then two instances sharing a backlog), and checks the
# editorial constraints (word count, pinned links, forbidden tech, image, drift).
# Exit code: 0 only if every check passes.
#
# The post's narrative is two terminals; this harness replays ONE shell. So every claim
# exists twice in index.md: the two-terminal form shown to the reader (outside the
# markers) and a single-shell equivalent inside them, which is what runs here.
set -u

PORT="${BLOG_WQ_PORT:-6398}"
CONTAINER="blog-workqueue-verify"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INDEX="$SCRIPT_DIR/index.md"
WORK="$(mktemp -d)"

STREAM="jobs.imageProcessing.v1"
GROUP="jobs-group"
DLQ="jobs.imageProcessing.v1:dlq"
TAG="blog-workqueue-v1"

PASS=0
FAIL=0

ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
ko() { echo "FAIL  $1${2:+ — $2}"; FAIL=$((FAIL + 1)); }
verdict() { if [ "$1" -eq 0 ]; then ok "$2"; else ko "$2" "${3:-}"; fi; }

rcli() { redis-cli -p "$PORT" "$@"; }

start_redis() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --rm --name "$CONTAINER" -p "127.0.0.1:${PORT}:6379" redis:8.8-alpine >/dev/null
  for _ in $(seq 1 50); do
    [ "$(rcli PING 2>/dev/null)" = "PONG" ] && return 0
    sleep 0.2
  done
  echo "FATAL: Redis container did not become ready" >&2
  exit 1
}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- helpers ---------------------------------------------------------------

# Reload the library + group on an empty keyspace. Every phase starts from here so the
# checks are order-independent.
reset_state() {
  rcli FLUSHALL >/dev/null
  (cd "$REPO_ROOT" && BLOG_WQ_PORT="$PORT" SEED_JOBS=0 "$SCRIPT_DIR/samples/setup.sh" >/dev/null 2>&1)
}

# $1 = how many jobs, all OK. The sample checks assert XPENDING back to 0 after the drain,
# and an Error job would legitimately still be pending (it needs maxDeliver deliveries plus a
# sweep, i.e. more idle time than a worker that exits after 3 idle polls will give it). The
# retry-then-DLQ path is covered by chk_walkthrough / chk_recovery instead.
seed_jobs() {
  local n="$1" i
  for i in $(seq 1 "$n"); do
    rcli XADD "$STREAM" '*' jobId "$(printf 'JOB-%04d' "$i")" \
      processingType OK createdAt '2026-08-11T00:00:00Z' >/dev/null
  done
}

# Extracts the ```bash blocks of one verify phase, in document order.
# Markers: <!-- verify:begin <phase> --> ... <!-- verify:end <phase> -->
blocks_for() {
  [ -f "$INDEX" ] || return 1
  awk -v phase="$1" '
    $0 ~ "<!-- verify:begin " phase " -->" { inphase = 1; next }
    $0 ~ "<!-- verify:end " phase " -->"   { inphase = 0 }
    inphase' "$INDEX" |
    awk '/^```bash/{c=1; next} /^```/{c=0} c'
}

# Runs the blocks of one or more phases in ONE shell, with redis-cli retargeted at the
# harness port. One shell matters: the post captures entry ids into variables
# (JOB1=$(redis-cli XADD …)) and a later phase references them.
# $1 = file to capture combined output into, $2… = phases in order.
run_phases() {
  local out="$1" phase blocks="" part
  shift
  for phase in "$@"; do
    part="$(blocks_for "$phase")" || return 1
    [ -n "$part" ] || return 1
    blocks="$blocks
$part"
  done
  blocks="${blocks//redis-cli /redis-cli -p $PORT }"
  (cd "$REPO_ROOT" && BLOG_WQ_PORT="$PORT" eval "$blocks") >"$out" 2>&1
}

# Entry ids (13-digit ms + sequence) present in the argument text.
entry_ids() { grep -oE '[0-9]{13}-[0-9]+' <<<"$1" | sort -u; }

# jobIds across every jobs.done.worker-* stream, duplicates kept.
completed_job_ids() {
  local i
  for i in $(seq 1 8); do
    rcli XRANGE "jobs.done.worker-$i" - + 2>/dev/null
  done | grep -oE 'JOB-[A-Z0-9]+'
}

pending_total() { rcli XPENDING "$STREAM" "$GROUP" 2>/dev/null | head -1; }

# --- checks ----------------------------------------------------------------

chk_shellcheck() {
  local rc=0 detail=""
  if ! command -v shellcheck >/dev/null 2>&1; then
    ko chk_shellcheck "shellcheck not installed"
    return
  fi
  shellcheck "${BASH_SOURCE[0]}" >"$WORK/sc-verify" 2>&1 || { rc=1; detail="verify.sh"; }
  if [ -f "$SCRIPT_DIR/samples/setup.sh" ]; then
    shellcheck "$SCRIPT_DIR/samples/setup.sh" >"$WORK/sc-setup" 2>&1 ||
      { rc=1; detail="$detail setup.sh"; }
  else
    rc=1
    detail="$detail samples/setup.sh missing"
  fi
  verdict "$rc" chk_shellcheck "$detail"
}

chk_setup() {
  if [ ! -f "$SCRIPT_DIR/samples/setup.sh" ]; then
    ko chk_setup "samples/setup.sh missing"
    return
  fi
  local rc=0 detail="" len1 len2
  rcli FLUSHALL >/dev/null
  (cd "$REPO_ROOT" && BLOG_WQ_PORT="$PORT" "$SCRIPT_DIR/samples/setup.sh" >/dev/null 2>&1) ||
    { rc=1; detail="first run failed"; }
  len1="$(rcli XLEN "$STREAM")"
  (cd "$REPO_ROOT" && BLOG_WQ_PORT="$PORT" "$SCRIPT_DIR/samples/setup.sh" >/dev/null 2>&1) ||
    { rc=1; detail="$detail second run failed"; }
  len2="$(rcli XLEN "$STREAM")"
  [ -n "$(rcli FUNCTION LIST LIBRARYNAME stream_utils)" ] ||
    { rc=1; detail="$detail library not loaded"; }
  rcli XINFO GROUPS "$STREAM" 2>/dev/null | grep -q "$GROUP" ||
    { rc=1; detail="$detail group missing"; }
  # Seeding must not double on a re-run.
  [ "$len1" = "$len2" ] || { rc=1; detail="$detail backlog doubled ($len1 -> $len2)"; }
  verdict "$rc" chk_setup "$detail"
}

# The full walkthrough, all phases in document order, ending in the state the post claims.
chk_walkthrough() {
  if [ ! -f "$INDEX" ]; then
    ko chk_walkthrough "index.md missing"
    return
  fi
  local rc=0 detail=""
  reset_state
  if ! run_phases "$WORK/walkthrough.out" split observe recovery; then
    rc=1
    detail="a verify phase is missing or failed"
  fi
  [ "$(pending_total)" = "0" ] || { rc=1; detail="$detail XPENDING=$(pending_total) (want 0)"; }
  [ "$(rcli XLEN "$DLQ")" = "1" ] || { rc=1; detail="$detail DLQ=$(rcli XLEN "$DLQ") (want 1)"; }
  verdict "$rc" chk_walkthrough "$detail"
}

# Two consumers reading the same group get DISJOINT entries. Never asserts a ratio:
# XREADGROUP gives each entry to whoever asks first, so a fast consumer takes more.
chk_distribution() {
  local rc=0 detail="" pel ids consumers
  reset_state
  if ! run_phases "$WORK/split.out" split; then
    ko chk_distribution "phase 'split' missing or failed"
    return
  fi
  # Live PEL right after the split phase: two rows, two consumers, two distinct ids.
  # (The split phase deliberately stops before any XACK, so the PEL still shows both.)
  pel="$(rcli XPENDING "$STREAM" "$GROUP" - + 20)"
  ids="$(entry_ids "$pel")"
  consumers="$(grep -oE 'worker-[0-9]+' <<<"$pel" | sort -u)"
  [ "$(wc -l <<<"$ids")" -ge 2 ] ||
    { rc=1; detail="$detail fewer than 2 entries held ($(wc -l <<<"$ids"))"; }
  [ "$(wc -l <<<"$consumers")" -ge 2 ] ||
    { rc=1; detail="$detail fewer than 2 consumers hold entries"; }
  # Disjointness: as many distinct ids as PEL rows.
  [ "$(wc -l <<<"$ids")" = "$(grep -cE 'worker-[0-9]+' <<<"$pel")" ] ||
    { rc=1; detail="$detail an entry is held twice"; }
  verdict "$rc" chk_distribution "$detail"
}

# A killed worker's entry is reclaimed by a peer after minIdle, and the killed consumer
# stays in the group (proof the post never tells the reader to XGROUP DELCONSUMER).
chk_recovery() {
  local rc=0 detail="" out consumers
  reset_state
  # All three phases: 'observe' is where worker-1 ACKs its finished job, without which
  # the reclaiming FCALL would pick up worker-1's own entry instead of the orphan.
  if ! run_phases "$WORK/rec.out" split observe recovery; then
    ko chk_recovery "a verify phase is missing or failed"
    return
  fi
  out="$(cat "$WORK/rec.out")"
  consumers="$(rcli XINFO CONSUMERS "$STREAM" "$GROUP")"
  # The killed consumer must survive: no XGROUP DELCONSUMER anywhere in the post.
  grep -qE 'worker-2' <<<"$consumers" ||
    { rc=1; detail="$detail worker-2 gone from the group"; }
  # The orphan must have been reclaimed by the peer AND then swept once its budget ran out.
  # Asserting on Redis state, not on the printed reply: an earlier version of this check
  # passed vacuously while the claim never fired because the idle margin was too thin.
  rcli XRANGE "$DLQ" - + | grep -q 'JOB-0002' ||
    { rc=1; detail="$detail JOB-0002 never reached the DLQ (claim or sweep did not fire)"; }
  [ "$(rcli XLEN "$DLQ")" = "1" ] ||
    { rc=1; detail="$detail DLQ holds $(rcli XLEN "$DLQ") entries (want exactly 1)"; }
  [ "$(pending_total)" = "0" ] ||
    { rc=1; detail="$detail XPENDING=$(pending_total) after recovery (want 0)"; }
  grep -qE '[0-9]{13}-[0-9]+' <<<"$out" ||
    { rc=1; detail="$detail recovery phase printed no entry id"; }
  verdict "$rc" chk_recovery "$detail"
}

# $1 = lang, $2 = required tool, $3... = run command (executed in samples/<lang>)
chk_sample() {
  local lang="$1" tool="$2"
  shift 2
  if [ ! -d "$SCRIPT_DIR/samples/$lang" ]; then
    ko "chk_sample_$lang" "samples/$lang missing"
    return
  fi
  if ! command -v "$tool" >/dev/null 2>&1; then
    ko "chk_sample_$lang" "toolchain '$tool' missing"
    return
  fi
  local rc=0 detail="" out ids unique

  # --- 1. alone: exits on its own, processes work, reports an idle stop ---
  reset_state
  seed_jobs 3
  out="$(cd "$SCRIPT_DIR/samples/$lang" &&
    REDIS_URL="redis://localhost:$PORT" SAMPLE_EXIT_AFTER_IDLE_POLLS=3 "$@" worker-1 2>&1)" ||
    { rc=1; detail="nonzero exit"; }
  grep -q "job JOB-.* -> worker-1" <<<"$out" || { rc=1; detail="$detail no 'job … -> worker-1' line"; }
  grep -qi "no new jobs" <<<"$out" || { rc=1; detail="$detail never reported an idle poll"; }

  # --- 2. two instances share a 10-job backlog, nothing processed twice ---
  reset_state
  seed_jobs 10
  (cd "$SCRIPT_DIR/samples/$lang" &&
    REDIS_URL="redis://localhost:$PORT" SAMPLE_EXIT_AFTER_IDLE_POLLS=3 "$@" worker-1 \
      >"$WORK/$lang-w1.log" 2>&1) &
  local p1=$!
  (cd "$SCRIPT_DIR/samples/$lang" &&
    REDIS_URL="redis://localhost:$PORT" SAMPLE_EXIT_AFTER_IDLE_POLLS=3 "$@" worker-2 \
      >"$WORK/$lang-w2.log" 2>&1) &
  local p2=$!
  wait "$p1" || { rc=1; detail="$detail worker-1 instance failed"; }
  wait "$p2" || { rc=1; detail="$detail worker-2 instance failed"; }

  grep -q "job JOB-" "$WORK/$lang-w1.log" || { rc=1; detail="$detail instance 1 processed nothing"; }
  grep -q "job JOB-" "$WORK/$lang-w2.log" || { rc=1; detail="$detail instance 2 processed nothing"; }
  ids="$(completed_job_ids)"
  unique="$(sort -u <<<"$ids")"
  [ "$(grep -c . <<<"$ids")" = "$(grep -c . <<<"$unique")" ] ||
    { rc=1; detail="$detail a job completed twice ($(grep -c . <<<"$ids") entries / $(grep -c . <<<"$unique") distinct)"; }
  [ "$(pending_total)" = "0" ] || { rc=1; detail="$detail XPENDING=$(pending_total) after drain"; }
  verdict "$rc" "chk_sample_$lang" "$detail"
}

chk_wordcount() {
  if [ ! -f "$INDEX" ]; then
    ko chk_wordcount "index.md missing"
    return
  fi
  local words
  words=$(awk '/^```/{c=!c; next} !c' "$INDEX" | sed -E 's/\(https?:[^)]*\)//g' | wc -w)
  if [ "$words" -ge 1600 ] && [ "$words" -le 1900 ]; then
    ok "chk_wordcount ($words)"
  else
    ko chk_wordcount "$words words (want 1600–1900)"
  fi
}

chk_links() {
  if [ ! -f "$INDEX" ]; then
    ko chk_links "index.md missing"
    return
  fi
  local rc=0 detail="" url path
  while IFS= read -r url; do
    case "$url" in
      */blob/* | */tree/*)
        case "$url" in
          *"/$TAG/"*) ;;
          *) rc=1; detail="$detail not pinned: $url" ;;
        esac
        path=$(sed -E "s#.*/(blob|tree)/$TAG/##; s/#.*$//" <<<"$url")
        if [ -n "$path" ] && [ ! -e "$REPO_ROOT/$path" ]; then
          rc=1
          detail="$detail missing path: $path"
        fi
        ;;
    esac
  done < <(grep -oE 'https://github\.com/dev-mansonthomas/RedisMessagingPatternsWithJedis[^) ]*' "$INDEX")
  grep -q "github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis" "$INDEX" ||
    { rc=1; detail="$detail no repo link at all"; }
  verdict "$rc" chk_links "$detail"
}

chk_forbidden() {
  if [ ! -f "$INDEX" ]; then
    ko chk_forbidden "index.md missing"
    return
  fi
  local hits
  hits=$(awk '/<!-- forbidden-exempt:begin -->/{e=1} /<!-- forbidden-exempt:end -->/{e=0; next} !e' "$INDEX" |
    awk '/^```/{c=!c; next} !c' | grep -ioE 'websocket|sockjs|angular|spring' | sort -u | tr '\n' ' ')
  if [ -n "$hits" ]; then
    ko chk_forbidden "$hits"
  else
    ok chk_forbidden
  fi
}

# XAUTOCLAIM and XNACK belong to other patterns / post #1 — out of scope by the brief.
# Scans authored content only: this harness names both commands in order to forbid them, and the
# clients we depend on ship their own XAUTOCLAIM/XNACK implementations under node_modules, .venv,
# target and bin — vendored code is not the post.
chk_no_xautoclaim() {
  local hits
  hits=$(grep -rloE 'XAUTOCLAIM|XNACK' "$INDEX" "$SCRIPT_DIR/samples" 2>/dev/null \
    --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=target \
    --exclude-dir=bin --exclude-dir=obj | tr '\n' ' ')
  if [ -n "$hits" ]; then
    ko chk_no_xautoclaim "$hits"
  else
    ok chk_no_xautoclaim
  fi
}

chk_img() {
  local rc=0 detail=""
  [ -f "$SCRIPT_DIR/img/work-queue-flow.png" ] || { rc=1; detail="png missing"; }
  grep -qE '!\[[^]]+\]\(img/work-queue-flow\.png\)' "$INDEX" 2>/dev/null ||
    { rc=1; detail="$detail not referenced with alt text"; }
  verdict "$rc" chk_img "$detail"
}

# The post must pin the demo's own SLOW timings, and the demo must still declare them.
chk_coherence() {
  local rc=0 detail="" svc prose
  svc="$REPO_ROOT/src/main/java/com/redis/patterns/service/WorkQueueService.java"
  grep -qE 'SLOW\("Slow", 2000, 5000' "$svc" ||
    { rc=1; detail="WorkQueueService no longer declares SLOW(2000, 5000)"; }
  prose=$(awk '/^```/{c=!c; next} !c' "$INDEX" 2>/dev/null)
  grep -q '2000' <<<"$prose" || { rc=1; detail="$detail post prose never states 2000"; }
  grep -q '5000' <<<"$prose" || { rc=1; detail="$detail post prose never states 5000"; }
  verdict "$rc" chk_coherence "$detail"
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

start_redis
chk_shellcheck
chk_setup
chk_walkthrough
chk_distribution
chk_recovery
# chk_sample appends the consumer name as the last argument, so java/node — whose runners
# take it via -Dexec.args / after the script name — go through `sh -c … _` to place it.
# The "$1" must be expanded by that inner sh, not here, hence the single quotes.
# shellcheck disable=SC2016
chk_sample java mvn sh -c 'mvn -q compile exec:java -Dexec.args="$1"' _
chk_sample python uv uv run work_queue_worker.py
# shellcheck disable=SC2016
chk_sample node npm sh -c 'npm install --silent >/dev/null 2>&1 && node work-queue-worker.mjs "$1"' _
chk_sample go go go run .
chk_sample csharp dotnet dotnet run --
chk_sample rust cargo cargo run -q --
chk_wordcount
chk_links
chk_forbidden
chk_no_xautoclaim
chk_img
chk_coherence

echo "----------------------------------------"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
