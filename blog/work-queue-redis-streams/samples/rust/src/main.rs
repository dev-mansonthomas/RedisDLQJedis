/*
Work Queue on Redis Streams — one competing-consumer worker. Run it twice to see the split.
This sample assumes no prior Redis knowledge.

QUICKSTART — paste the indented lines into a terminal (needs Docker + Rust):

    git clone https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis.git
    cd RedisMessagingPatternsWithJedis
    export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
    cd blog/work-queue-redis-streams/samples/rust && cargo run -q -- worker-1

Then, in a SECOND terminal, the same command with a different consumer name — that is the whole
point of the pattern:

    export REDIS_URL="redis://localhost:6379"   # the port setup.sh printed
    cd RedisMessagingPatternsWithJedis/blog/work-queue-redis-streams/samples/rust
    cargo run -q -- worker-2

setup.sh loads the Lua function, creates the group and queues 10 jobs; if nothing is listening on
localhost:6379 it starts a throwaway Redis 8.8 in Docker on a free port and prints that port.
Streams and consumer groups are explained from scratch in post #1:
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/tree/blog-dlq-v1/blog/dlq-redis-streams

Two read paths, one handler:
  - hot path: XREADGROUP … BLOCK 1000, because a blocking read is how you consume a queue;
  - every other iteration: FCALL read_claim_or_dlq, which reclaims entries orphaned by a dead
    worker and routes exhausted ones to the DLQ (a Lua function cannot block, hence two calls).
The function's last step is itself an XREADGROUP, so its reply carries NEW jobs too — feeding it to
a different code path would leak a job that is read and never acknowledged.

Env:
  REDIS_URL                      default redis://localhost:6379
  SAMPLE_EXIT_AFTER_IDLE_POLLS   unset = run forever (what a real worker does).
                                 Set to N to exit 0 after N polls that found nothing.

There is deliberately NO signal handler: killing this process with Ctrl-C while it holds a job is
the crash-recovery demo. The entry stays in the group's pending list and a peer reclaims it after
minIdle. Do not "fix" this by acknowledging on exit.
*/

use std::collections::HashMap;
use std::thread::sleep;
use std::time::Duration;

use redis::streams::{StreamReadOptions, StreamReadReply};
use redis::{Commands, Value};

const STREAM: &str = "jobs.imageProcessing.v1";
const DLQ: &str = "jobs.imageProcessing.v1:dlq";
const GROUP: &str = "jobs-group";

const WORK_MS: u64 = 2000; // simulated work — the demo's SLOW pace, matching the article
const MIN_IDLE_MS: usize = 5000; // idle this long and a peer may claim it; MUST outlast WORK_MS
const COUNT: usize = 1;
const MAX_DELIVER: usize = 2;

type Job = (String, HashMap<String, String>);

fn as_string(value: &Value) -> String {
    match value {
        Value::BulkString(bytes) => String::from_utf8_lossy(bytes).to_string(),
        Value::SimpleString(s) => s.clone(),
        Value::Int(i) => i.to_string(),
        other => format!("{other:?}"),
    }
}

/// Hot path: block up to a second waiting for a job nobody has taken.
fn blocking_read(con: &mut redis::Connection, consumer: &str) -> Vec<Job> {
    let opts = StreamReadOptions::default()
        .group(GROUP, consumer)
        .count(COUNT)
        .block(1000);

    // BLOCK expiring with nothing to read comes back as Nil, hence the Option.
    let reply: Option<StreamReadReply> = match con.xread_options(&[STREAM], &[">"], &opts) {
        Ok(reply) => reply,
        Err(err) => {
            println!("{consumer}: read error: {err}");
            return Vec::new();
        }
    };

    let mut jobs = Vec::new();
    if let Some(reply) = reply {
        for key in reply.keys {
            for entry in key.ids {
                let fields = entry
                    .map
                    .iter()
                    .map(|(k, v)| (k.clone(), as_string(v)))
                    .collect();
                jobs.push((entry.id, fields));
            }
        }
    }
    jobs
}

/// Catch-up path: reclaim entries orphaned by a dead worker and route exhausted ones to the DLQ.
/// Its messages go through the same handler as the blocking read.
fn sweep(con: &mut redis::Connection, consumer: &str) -> Vec<Job> {
    let reply: Value = match redis::cmd("FCALL")
        .arg("read_claim_or_dlq")
        .arg(2)
        .arg(STREAM)
        .arg(DLQ)
        .arg(GROUP)
        .arg(consumer)
        .arg(MIN_IDLE_MS)
        .arg(COUNT)
        .arg(MAX_DELIVER)
        .query(con)
    {
        Ok(value) => value,
        Err(err) => {
            println!("{consumer}: sweep error: {err}");
            return Vec::new();
        }
    };

    let Value::Array(parts) = reply else {
        return Vec::new();
    };

    let mut jobs = Vec::new();
    if let Some(Value::Array(messages)) = parts.first() {
        for raw in messages {
            if let Value::Array(pair) = raw {
                if pair.len() < 2 {
                    continue;
                }
                let id = as_string(&pair[0]);
                let mut fields = HashMap::new();
                if let Value::Array(flat) = &pair[1] {
                    for chunk in flat.chunks(2) {
                        if let [k, v] = chunk {
                            fields.insert(as_string(k), as_string(v));
                        }
                    }
                }
                jobs.push((id, fields));
            }
        }
    }

    // parts[1] = [[original_id, dlq_id], …] — jobs that burned their delivery budget.
    if let Some(Value::Array(routed)) = parts.get(1) {
        for raw in routed {
            if let Value::Array(pair) = raw {
                if pair.len() >= 2 {
                    println!(
                        "{consumer}: DLQ {} -> {}",
                        as_string(&pair[0]),
                        as_string(&pair[1])
                    );
                }
            }
        }
    }
    jobs
}

fn handle(con: &mut redis::Connection, consumer: &str, (id, fields): &Job) {
    let job_id = fields.get("jobId").cloned().unwrap_or_else(|| "?".into());
    println!("job {job_id} -> {consumer}");
    sleep(Duration::from_millis(WORK_MS));

    if fields.get("processingType").map(String::as_str) != Some("OK") {
        // Failure: do NOT acknowledge. The delivery count climbs, and once it reaches
        // maxDeliver the next sweep routes the job to the DLQ.
        println!("{consumer}: job {job_id} failed, not acknowledging");
        return;
    }

    // The result first, then the ACK. Two commands, not one transaction: a crash between them
    // re-delivers the job and produces a duplicate result. At-least-once means whatever reads the
    // done stream must be idempotent.
    let pairs: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let _: Result<String, _> = con.xadd(format!("jobs.done.{consumer}"), "*", &pairs);
    let _: Result<i64, _> = con.xack(STREAM, GROUP, &[id]);
    println!("{consumer}: job {job_id} done");
}

fn main() -> redis::RedisResult<()> {
    let consumer = std::env::args()
        .nth(1)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "worker-1".to_string());
    let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    let exit_after_idle: usize = std::env::var("SAMPLE_EXIT_AFTER_IDLE_POLLS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    println!("{consumer} connecting to {url}");
    let client = redis::Client::open(url.as_str())?;
    let mut con = client.get_connection()?;

    let mut iteration: u64 = 0;
    let mut idle_polls: usize = 0;
    loop {
        iteration += 1;
        let mut work = blocking_read(&mut con, &consumer);
        if iteration % 2 == 0 {
            work.extend(sweep(&mut con, &consumer));
        }

        if work.is_empty() {
            idle_polls += 1;
            println!("{consumer}: no new jobs");
            if exit_after_idle > 0 && idle_polls >= exit_after_idle {
                println!("{consumer}: idle {idle_polls} times, exiting");
                return Ok(());
            }
            continue;
        }

        idle_polls = 0;
        for job in &work {
            handle(&mut con, &consumer, job);
        }
    }
}
