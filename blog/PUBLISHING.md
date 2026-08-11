# Publishing a blog post — the pinned tag procedure

Every post under `blog/<slug>/` links to its own code with **absolute GitHub permalinks pinned to a
tag**, not to `main`:

```
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/blob/blog-dlq-v1/blog/dlq-redis-streams/samples/java/...
                                                                        ^^^^^^^^^^^ the tag
```

**Why a tag and not `main`.** A published article is frozen in time on the Redis blog / CMS, but the
repo keeps moving. Pinning the links to an immutable tag means the code a reader sees always matches
what the article describes — including exact line ranges (`#L153-L170`) — no matter how `main`
evolves afterwards. Links to `main` would silently drift or break.

**Consequence:** the permalinks return **404 until the tag is pushed**, and the tag is pushed *from
the host* (the VM holds no GitHub credentials). This is expected: the acceptance harness
(`verify.sh` → `chk_links`) only checks that each linked path exists locally, not that the tag is
live yet.

## Naming convention

| Part | Rule | Example |
|------|------|---------|
| Tag | `blog-<short-slug>-v<N>` | `blog-dlq-v1`, `blog-workqueue-v1` |
| `<short-slug>` | the post's short name (not the full dir) | `dlq` for `blog/dlq-redis-streams/`, `workqueue` for `blog/work-queue-redis-streams/` |
| `<N>` | bump on any republish that changes linked code/line numbers | `v1`, `v2`, … |

The tag string is fixed in the post's spec (`docs/specs/blog-<post>.md`) and hard-coded in every
permalink, so it must match exactly.

## Procedure (run on the host, at publication time)

Pre-flight — pick the commit to freeze. It must be a commit on `main` that contains the post **and**
every path the post links to (all samples + any source-code excerpt) with the **line numbers the
permalinks assume**. Normally that is `main` right after the post's PRs are merged.

```bash
# 1. up-to-date main
git checkout main
git pull --ff-only

# 2. confirm every linked path exists at the commit you're about to tag (HERE: main HEAD)
#    (edit the tag/slug for other posts)
TAG=blog-dlq-v1
SLUG=dlq-redis-streams
for p in \
  blog/$SLUG/samples/setup.sh \
  blog/$SLUG/samples/java/src/main/java/DlqExample.java \
  blog/$SLUG/samples/python/dlq_example.py \
  blog/$SLUG/samples/node/dlq-example.mjs \
  blog/$SLUG/samples/go/main.go \
  blog/$SLUG/samples/csharp/Program.cs \
  blog/$SLUG/samples/rust/src/main.rs \
  src/main/java/com/redis/patterns/service/DLQMessagingService.java ; do
    git cat-file -e "HEAD:$p" && echo "OK  $p" || echo "MISSING  $p"
done

# 3. create the annotated tag on that commit (pin the SHA to stay deterministic
#    even if main advances) and push only the tag
git tag -a "$TAG" "$(git rev-parse HEAD)" -m "Redis blog post — DLQ on Redis Streams (publication snapshot)"
git push origin "$TAG"
```

### Path list — post #2 (`blog-workqueue-v1`)

Same procedure, different paths. The post links six samples, `setup.sh`, and two line ranges in the
demo's service, so all of them must exist at the commit you tag:

```bash
TAG=blog-workqueue-v1
SLUG=work-queue-redis-streams
for p in \
  blog/$SLUG/samples/setup.sh \
  blog/$SLUG/samples/java/src/main/java/WorkQueueWorker.java \
  blog/$SLUG/samples/python/work_queue_worker.py \
  blog/$SLUG/samples/node/work-queue-worker.mjs \
  blog/$SLUG/samples/go/main.go \
  blog/$SLUG/samples/csharp/Program.cs \
  blog/$SLUG/samples/rust/src/main.rs \
  src/main/java/com/redis/patterns/service/WorkQueueService.java ; do
    git cat-file -e "HEAD:$p" && echo "OK  $p" || echo "MISSING  $p"
done
```

**Line numbers matter for this post.** It pins `WorkQueueService.java#L225-L229` (the `fcall` call) and
`#L478` (`removeWorker`). If either moves before you tag, fix the permalinks first — the harness's
`chk_links` only checks that the *file* exists, not that the lines still say what the article claims.

## Verify the links resolve

```bash
curl -sI -o /dev/null -w '%{http_code}\n' \
  "https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/blob/blog-dlq-v1/blog/dlq-redis-streams/samples/java/src/main/java/DlqExample.java"
# → 200
```

To check all of a post's links at once, extract them and curl each:

```bash
grep -oE 'https://github\.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/(blob|tree)/blog-dlq-v1/[^) ]*' \
  blog/dlq-redis-streams/index.md blog/dlq-redis-streams/index.fr.md | sort -u |
while read -r url; do printf '%s  %s\n' "$(curl -sI -o /dev/null -w '%{http_code}' "$url")" "$url"; done
# every line should start with 200
```

## Moving a tag after a fix

If you must republish with a corrected sample (and choose to keep the same `vN` rather than bump to
`v2`), re-point the tag and force-push **only the tag**:

```bash
git tag -fa blog-dlq-v1 "$(git rev-parse HEAD)" -m "…"
git push --force origin blog-dlq-v1
```

Prefer bumping to `blog-dlq-v2` (and updating the permalinks in a new post revision) if the article
is already live — moving a published tag changes code under readers who bookmarked it. Never
force-push branches; this force-push targets a single tag ref only.
