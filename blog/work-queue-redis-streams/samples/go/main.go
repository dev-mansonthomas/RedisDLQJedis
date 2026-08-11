/*
Work Queue on Redis Streams — one competing-consumer worker. Run it twice to see the split.
This sample assumes no prior Redis knowledge.

QUICKSTART — paste the indented lines into a terminal (needs Docker + Go):

	git clone https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis.git
	cd RedisMessagingPatternsWithJedis
	export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
	cd blog/work-queue-redis-streams/samples/go && go run . worker-1

Then, in a SECOND terminal, the same command with a different consumer name — that is the whole
point of the pattern:

	export REDIS_URL="redis://localhost:6379"   # the port setup.sh printed
	cd RedisMessagingPatternsWithJedis/blog/work-queue-redis-streams/samples/go
	go run . worker-2

setup.sh loads the Lua function, creates the group and queues 10 jobs; if nothing is listening on
localhost:6379 it starts a throwaway Redis 8.8 in Docker on a free port and prints that port.
Streams and consumer groups are explained from scratch in post #1:
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/tree/blog-dlq-v1/blog/dlq-redis-streams

Two read paths, one handler:
  - hot path: XREADGROUP … BLOCK 1s, because a blocking read is how you consume a queue;
  - every other iteration: FCALL read_claim_or_dlq, which reclaims entries orphaned by a dead
    worker and routes exhausted ones to the DLQ (a Lua function cannot block, hence two calls).

The function's last step is itself an XREADGROUP, so its reply carries NEW jobs too — feeding it to
a different code path would leak a job that is read and never acknowledged.

Env:

	REDIS_URL                      default redis://localhost:6379
	SAMPLE_EXIT_AFTER_IDLE_POLLS   unset = run forever (what a real worker does).
	                               Set to N to exit 0 after N polls that found nothing.

There is deliberately NO signal handling: killing this process with Ctrl-C while it holds a job is
the crash-recovery demo. The entry stays in the group's pending list and a peer reclaims it after
minIdle. Do not "fix" this by acknowledging on exit.
*/
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	stream = "jobs.imageProcessing.v1"
	dlq    = "jobs.imageProcessing.v1:dlq"
	group  = "jobs-group"

	workMS     = 2000 // simulated work — the demo's SLOW pace, matching the article
	minIdleMS  = 5000 // idle this long and a peer may claim it; MUST outlast workMS
	count      = 1
	maxDeliver = 2
)

type job struct {
	id     string
	fields map[string]string
}

var (
	ctx      = context.Background()
	consumer = "worker-1"
)

// blockingRead is the hot path: block up to a second waiting for a job nobody has taken.
func blockingRead(rdb *redis.Client) []job {
	streams, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    group,
		Consumer: consumer,
		Streams:  []string{stream, ">"},
		Count:    count,
		Block:    time.Second,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return nil // BLOCK expired with nothing to read
	}
	if err != nil {
		fmt.Printf("%s: read error: %v\n", consumer, err)
		return nil
	}

	var jobs []job
	for _, s := range streams {
		for _, m := range s.Messages {
			fields := make(map[string]string, len(m.Values))
			for k, v := range m.Values {
				fields[k] = fmt.Sprint(v)
			}
			jobs = append(jobs, job{id: m.ID, fields: fields})
		}
	}
	return jobs
}

// sweep is the catch-up path: reclaim entries orphaned by a dead worker and route exhausted ones
// to the DLQ. Its messages go through the same handler as the blocking read.
func sweep(rdb *redis.Client) []job {
	reply, err := rdb.FCall(ctx, "read_claim_or_dlq",
		[]string{stream, dlq},
		group, consumer, strconv.Itoa(minIdleMS), strconv.Itoa(count), strconv.Itoa(maxDeliver),
	).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		fmt.Printf("%s: sweep error: %v\n", consumer, err)
		return nil
	}

	parts, ok := reply.([]interface{})
	if !ok || len(parts) == 0 {
		return nil
	}

	var jobs []job
	if messages, ok := parts[0].([]interface{}); ok {
		for _, raw := range messages {
			pair, ok := raw.([]interface{})
			if !ok || len(pair) < 2 {
				continue
			}
			flat, _ := pair[1].([]interface{})
			fields := make(map[string]string, len(flat)/2)
			for i := 0; i+1 < len(flat); i += 2 {
				fields[fmt.Sprint(flat[i])] = fmt.Sprint(flat[i+1])
			}
			jobs = append(jobs, job{id: fmt.Sprint(pair[0]), fields: fields})
		}
	}

	// parts[1] = [[originalID, dlqID], …] — jobs that burned their delivery budget.
	if len(parts) > 1 {
		if routed, ok := parts[1].([]interface{}); ok {
			for _, raw := range routed {
				if pair, ok := raw.([]interface{}); ok && len(pair) >= 2 {
					fmt.Printf("%s: DLQ %v -> %v\n", consumer, pair[0], pair[1])
				}
			}
		}
	}
	return jobs
}

func handle(rdb *redis.Client, j job) {
	jobID, ok := j.fields["jobId"]
	if !ok {
		jobID = "?"
	}
	fmt.Printf("job %s -> %s\n", jobID, consumer)
	time.Sleep(workMS * time.Millisecond)

	if j.fields["processingType"] != "OK" {
		// Failure: do NOT acknowledge. The delivery count climbs, and once it reaches
		// maxDeliver the next sweep routes the job to the DLQ.
		fmt.Printf("%s: job %s failed, not acknowledging\n", consumer, jobID)
		return
	}

	// The result first, then the ACK. Two commands, not one transaction: a crash between them
	// re-delivers the job and produces a duplicate result. At-least-once means whatever reads the
	// done stream must be idempotent.
	values := make(map[string]interface{}, len(j.fields))
	for k, v := range j.fields {
		values[k] = v
	}
	rdb.XAdd(ctx, &redis.XAddArgs{Stream: "jobs.done." + consumer, Values: values})
	rdb.XAck(ctx, stream, group, j.id)
	fmt.Printf("%s: job %s done\n", consumer, jobID)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] != "" {
		consumer = os.Args[1]
	}
	url := os.Getenv("REDIS_URL")
	if url == "" {
		url = "redis://localhost:6379"
	}
	exitAfterIdle, _ := strconv.Atoi(os.Getenv("SAMPLE_EXIT_AFTER_IDLE_POLLS"))

	fmt.Printf("%s connecting to %s\n", consumer, url)
	opt, err := redis.ParseURL(url)
	if err != nil {
		fmt.Printf("bad REDIS_URL: %v\n", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()

	iteration := 0
	idlePolls := 0
	for {
		iteration++
		work := blockingRead(rdb)
		if iteration%2 == 0 {
			work = append(work, sweep(rdb)...)
		}

		if len(work) == 0 {
			idlePolls++
			fmt.Printf("%s: no new jobs\n", consumer)
			if exitAfterIdle > 0 && idlePolls >= exitAfterIdle {
				fmt.Printf("%s: idle %d times, exiting\n", consumer, idlePolls)
				return
			}
			continue
		}

		idlePolls = 0
		for _, j := range work {
			handle(rdb, j)
		}
	}
}
