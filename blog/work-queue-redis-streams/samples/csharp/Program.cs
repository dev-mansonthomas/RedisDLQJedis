/*
Work Queue on Redis Streams — one competing-consumer worker. Run it twice to see the split.
This sample assumes no prior Redis knowledge.

QUICKSTART — paste the indented lines into a terminal (needs Docker + .NET SDK):

    git clone https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis.git
    cd RedisMessagingPatternsWithJedis
    export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
    cd blog/work-queue-redis-streams/samples/csharp && dotnet run -- worker-1

Then, in a SECOND terminal, the same command with a different consumer name — that is the whole
point of the pattern:

    export REDIS_URL="redis://localhost:6379"   # the port setup.sh printed
    cd RedisMessagingPatternsWithJedis/blog/work-queue-redis-streams/samples/csharp
    dotnet run -- worker-2

setup.sh loads the Lua function, creates the group and queues 10 jobs; if nothing is listening on
localhost:6379 it starts a throwaway Redis 8.8 in Docker on a free port and prints that port.
Streams and consumer groups are explained from scratch in post #1:
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/tree/blog-dlq-v1/blog/dlq-redis-streams

*** THIS SAMPLE POLLS, THE OTHER FIVE BLOCK. ***
StackExchange.Redis (which NRedisStack sits on) ships no blocking commands on purpose: it
multiplexes every caller over one connection, so a blocking read would stall unrelated callers.
Its own documentation says so, and StreamReadGroup has no BLOCK parameter. The idiomatic answer
with this client is therefore to poll — read, and sleep when the read comes back empty — or to be
woken by a pub/sub notification and then read without blocking. Everything else about the pattern
is identical: same group, same consumer names, same function, same guarantees.

Two read paths, one handler:
  - hot path: StreamReadGroup (poll, see above);
  - every other iteration: FCALL read_claim_or_dlq, which reclaims entries orphaned by a dead
    worker and routes exhausted ones to the DLQ (a Lua function cannot block either).
The function's last step is itself an XREADGROUP, so its reply carries NEW jobs too — feeding it to
a different code path would leak a job that is read and never acknowledged.

Env:
  REDIS_URL                      default redis://localhost:6379
  SAMPLE_EXIT_AFTER_IDLE_POLLS   unset = run forever (what a real worker does).
                                 Set to N to exit 0 after N polls that found nothing.

There is deliberately NO Ctrl-C handler: killing this process while it holds a job is the
crash-recovery demo. The entry stays in the group's pending list and a peer reclaims it after
minIdle. Do not "fix" this by acknowledging on exit.
*/

using StackExchange.Redis;

const string Stream = "jobs.imageProcessing.v1";
const string Dlq = "jobs.imageProcessing.v1:dlq";
const string Group = "jobs-group";

const int WorkMs = 2000;      // simulated work — the demo's SLOW pace, matching the article
const int MinIdleMs = 5000;   // idle this long and a peer may claim it; MUST outlast WorkMs
const int Count = 1;
const int MaxDeliver = 2;
const int PollSleepMs = 1000; // what the other five samples get from BLOCK 1000

var consumer = args.Length > 0 && args[0].Length > 0 ? args[0] : "worker-1";
var url = Environment.GetEnvironmentVariable("REDIS_URL") ?? "redis://localhost:6379";
var exitAfterIdle = int.TryParse(
    Environment.GetEnvironmentVariable("SAMPLE_EXIT_AFTER_IDLE_POLLS"), out var n) ? n : 0;

Console.WriteLine($"{consumer} connecting to {url}");

// StackExchange.Redis wants host:port, not a redis:// URL — strip the scheme.
var endpoint = url.Replace("redis://", "").TrimEnd('/');
using var redis = await ConnectionMultiplexer.ConnectAsync(endpoint);
var db = redis.GetDatabase();

var iteration = 0L;
var idlePolls = 0;

while (true)
{
    iteration++;
    var work = new List<(string Id, Dictionary<string, string> Fields)>();
    work.AddRange(PollRead());

    if (iteration % 2 == 0)
    {
        work.AddRange(await SweepAsync());
    }

    if (work.Count == 0)
    {
        idlePolls++;
        Console.WriteLine($"{consumer}: no new jobs");
        if (exitAfterIdle > 0 && idlePolls >= exitAfterIdle)
        {
            Console.WriteLine($"{consumer}: idle {idlePolls} times, exiting");
            return 0;
        }
        await Task.Delay(PollSleepMs); // the poll interval this client forces on us
        continue;
    }

    idlePolls = 0;
    foreach (var job in work)
    {
        await HandleAsync(job);
    }
}

// Hot path: read one job nobody has taken. No BLOCK — see the note at the top of this file.
List<(string Id, Dictionary<string, string> Fields)> PollRead()
{
    var entries = db.StreamReadGroup(Stream, Group, consumer, ">", count: Count);
    var jobs = new List<(string, Dictionary<string, string>)>();
    foreach (var entry in entries)
    {
        var fields = new Dictionary<string, string>();
        foreach (var field in entry.Values)
        {
            fields[field.Name!] = field.Value.ToString();
        }
        jobs.Add((entry.Id.ToString(), fields));
    }
    return jobs;
}

// Catch-up path: reclaim entries orphaned by a dead worker and route exhausted ones to the DLQ.
// Its messages go through the same handler as the poll.
async Task<List<(string Id, Dictionary<string, string> Fields)>> SweepAsync()
{
    var jobs = new List<(string, Dictionary<string, string>)>();
    var result = await db.ExecuteAsync("FCALL", "read_claim_or_dlq", 2,
        Stream, Dlq, Group, consumer, MinIdleMs, Count, MaxDeliver);

    var outer = (RedisResult[]?)result;
    if (outer is null || outer.Length == 0)
    {
        return jobs;
    }

    // outer[0] = [[id, [field, value, ...]], ...]
    foreach (var raw in (RedisResult[])outer[0]!)
    {
        var entry = (RedisResult[])raw!;
        if (entry.Length < 2)
        {
            continue;
        }
        var flat = (RedisResult[])entry[1]!;
        var fields = new Dictionary<string, string>();
        for (var i = 0; i + 1 < flat.Length; i += 2)
        {
            fields[Str(flat[i])] = Str(flat[i + 1]);
        }
        jobs.Add((Str(entry[0]), fields));
    }

    // outer[1] = [[originalId, dlqId], ...] — jobs that burned their delivery budget.
    if (outer.Length > 1)
    {
        foreach (var raw in (RedisResult[])outer[1]!)
        {
            var pair = (RedisResult[])raw!;
            if (pair.Length >= 2)
            {
                Console.WriteLine($"{consumer}: DLQ {Str(pair[0])} -> {Str(pair[1])}");
            }
        }
    }
    return jobs;
}

async Task HandleAsync((string Id, Dictionary<string, string> Fields) job)
{
    var jobId = job.Fields.TryGetValue("jobId", out var id) ? id : "?";
    Console.WriteLine($"job {jobId} -> {consumer}");
    await Task.Delay(WorkMs);

    if (!job.Fields.TryGetValue("processingType", out var type) || type != "OK")
    {
        // Failure: do NOT acknowledge. The delivery count climbs, and once it reaches
        // maxDeliver the next sweep routes the job to the DLQ.
        Console.WriteLine($"{consumer}: job {jobId} failed, not acknowledging");
        return;
    }

    // The result first, then the ACK. Two commands, not one transaction: a crash between them
    // re-delivers the job and produces a duplicate result. At-least-once means whatever reads the
    // done stream must be idempotent.
    var values = job.Fields
        .Select(kv => new NameValueEntry(kv.Key, kv.Value))
        .ToArray();
    await db.StreamAddAsync($"jobs.done.{consumer}", values);
    await db.StreamAcknowledgeAsync(Stream, Group, job.Id);
    Console.WriteLine($"{consumer}: job {jobId} done");
}

static string Str(RedisResult r) => (string?)r ?? "";
