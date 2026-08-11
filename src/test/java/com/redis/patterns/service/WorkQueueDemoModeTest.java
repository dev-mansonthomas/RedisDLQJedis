package com.redis.patterns.service;

import com.redis.patterns.service.WorkQueueService.DemoMode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Guards the demo-mode timing table. No Redis, no Docker — this must run (and can fail) on every
 * machine, because the property it checks is the pattern's central tuning constraint.
 *
 * <p>Behavior of switching modes at runtime is covered by
 * {@code WorkQueueScalingIntegrationTest#switchingDemoModeRetimesTheRunningPool}.
 */
class WorkQueueDemoModeTest {

    /**
     * The invariant: {@code minIdle} must outlast the simulated work time, with margin. Otherwise a
     * free worker claims a job its busy peer is still processing and the job runs twice, silently.
     *
     * <p>This is measured, not hypothetical: the 100 ms / 100 ms pair shipped before 2026-08-03
     * duplicated 120 of 266 completed jobs in a live run of the page.
     */
    @ParameterizedTest
    @EnumSource(DemoMode.class)
    void minIdleOutlastsTheWorkTimeWithMargin(DemoMode mode) {
        assertThat(mode.minIdleMs())
                .as("%s: minIdle must be >= 2x the work time, else jobs are processed twice", mode)
                .isGreaterThanOrEqualTo(2 * mode.workMs());
    }

    /** A worker must be able to pick up its next job well inside the claim window. */
    @ParameterizedTest
    @EnumSource(DemoMode.class)
    void pollingIsFastEnoughToNotStarveTheClaimWindow(DemoMode mode) {
        assertThat(mode.pollMs())
                .as("%s: the poll interval must stay below minIdle", mode)
                .isLessThan(mode.minIdleMs());
    }

    @Test
    void slowIsWatchableAndFastIsBrisk() {
        assertThat(DemoMode.SLOW.workMs()).isGreaterThanOrEqualTo(1000);
        assertThat(DemoMode.FAST.workMs()).isLessThanOrEqualTo(100);
        assertThat(DemoMode.SLOW.producerSleepMs()).isGreaterThan(DemoMode.FAST.producerSleepMs());
        assertThat(DemoMode.SLOW.burstSize()).isLessThan(DemoMode.FAST.burstSize());
    }

    /**
     * A burst must stay watchable: with the pool at its 4-worker default it should drain in roughly
     * 5-60 s, otherwise the demo either blinks past or outlasts the audience.
     */
    @ParameterizedTest
    @EnumSource(DemoMode.class)
    void aBurstDrainsInAWatchableTime(DemoMode mode) {
        long perJobMs = mode.workMs() + mode.pollMs();
        long drainSeconds = (mode.burstSize() * perJobMs) / 4 / 1000;

        assertThat(drainSeconds)
                .as("%s: %d jobs at ~%d ms each over 4 workers", mode, mode.burstSize(), perJobMs)
                .isBetween(2L, 60L);
        assertThat(mode.burstSize()).isBetween(1, WorkQueueService.MAX_BURST);
    }

    /** The frontend labels its dropdown from these keys; renaming one silently empties the label. */
    @ParameterizedTest
    @EnumSource(DemoMode.class)
    void describeCarriesEveryFieldTheDropdownNeeds(DemoMode mode) {
        Map<String, Object> described = mode.describe();

        assertThat(described)
                .containsEntry("name", mode.name())
                .containsEntry("label", mode.label())
                .containsEntry("workMs", mode.workMs())
                .containsEntry("minIdleMs", mode.minIdleMs())
                .containsEntry("pollMs", mode.pollMs())
                .containsEntry("producerSleepMs", mode.producerSleepMs())
                .containsEntry("burstSize", mode.burstSize());
    }

    @Test
    void theStartupDefaultIsFast() {
        assertThat(WorkQueueService.DEFAULT_DEMO_MODE).isEqualTo(DemoMode.FAST);
    }
}
