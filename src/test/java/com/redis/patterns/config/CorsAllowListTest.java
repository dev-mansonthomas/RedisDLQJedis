package com.redis.patterns.config;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Pins the CORS allow-list documented in {@link CorsConfig} and forbids per-controller
 * {@code @CrossOrigin} wildcards from re-appearing.
 *
 * <p>The wildcard case is a characterization test: it records what the shipped filter chain
 * actually does when a controller contradicts the global policy, rather than reasoning about
 * annotation-vs-registry precedence.
 */
class CorsAllowListTest {

    private static final String ALLOWED = "http://localhost:4200,http://localhost:8080";
    private static final String ALLOWED_ORIGIN = "http://localhost:4200";
    private static final String FOREIGN_ORIGIN = "https://evil.example";
    private static final String CONTROLLER_PACKAGE = "com.redis.patterns.controller";

    /** Builds the real {@link CorsConfig} filter in front of a standalone dispatcher. */
    private MockMvc mvcFor(Object controller) {
        CorsConfig config = new CorsConfig();
        ReflectionTestUtils.setField(config, "allowedOrigins", ALLOWED);
        return MockMvcBuilders.standaloneSetup(controller)
                .addFilters(config.corsFilter())
                .build();
    }

    @RestController
    static class PlainController {
        @GetMapping("/probe")
        String probe() {
            return "ok";
        }
    }

    @CrossOrigin(origins = "*")
    @RestController
    static class WildcardController {
        @GetMapping("/probe")
        String probe() {
            return "ok";
        }
    }

    @Test
    void anAllowedOriginIsEchoedBack() throws Exception {
        mvcFor(new PlainController())
                .perform(get("/probe").header("Origin", ALLOWED_ORIGIN))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", ALLOWED_ORIGIN));
    }

    @Test
    void aForeignOriginIsRejected() throws Exception {
        mvcFor(new PlainController())
                .perform(get("/probe").header("Origin", FOREIGN_ORIGIN))
                .andExpect(status().isForbidden());
    }

    @Test
    void aForeignPreflightIsRejected() throws Exception {
        mvcFor(new PlainController())
                .perform(options("/probe")
                        .header("Origin", FOREIGN_ORIGIN)
                        .header("Access-Control-Request-Method", "GET"))
                .andExpect(status().isForbidden());
    }

    @Test
    void aWildcardCrossOriginAnnotationDoesNotDefeatTheFilter() throws Exception {
        mvcFor(new WildcardController())
                .perform(get("/probe").header("Origin", FOREIGN_ORIGIN))
                .andExpect(status().isForbidden())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test
    void noControllerCarriesACrossOriginAnnotation() throws Exception {
        ClassPathScanningCandidateComponentProvider scanner =
                new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));

        List<String> controllers = new ArrayList<>();
        List<String> offenders = new ArrayList<>();
        for (var candidate : scanner.findCandidateComponents(CONTROLLER_PACKAGE)) {
            Class<?> type = Class.forName(candidate.getBeanClassName());
            controllers.add(type.getSimpleName());
            if (type.isAnnotationPresent(CrossOrigin.class)) {
                offenders.add(type.getSimpleName());
            }
            for (Method method : type.getDeclaredMethods()) {
                if (method.isAnnotationPresent(CrossOrigin.class)) {
                    offenders.add(type.getSimpleName() + "#" + method.getName());
                }
            }
        }

        // Guard against a vacuous pass: the scan must actually see the controllers.
        assertThat(controllers).as("@RestController classes found").hasSizeGreaterThanOrEqualTo(12);
        assertThat(offenders)
                .as("CORS is owned by CorsConfig; a per-controller @CrossOrigin contradicts it")
                .isEmpty();
    }
}
