import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlannerStore } from "../store.js";

describe("PlannerStore", () => {
  let store: PlannerStore;

  beforeEach(() => {
    const dbPath = `/tmp/planner-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new PlannerStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it("saves and retrieves a sprint plan", () => {
    const sprint = store.saveSprint({
      intent: "ship blog and fix bugs",
      budget: 5,
      constraints: ["no more than 2 infra agents"],
      groups: [
        {
          persona: "builder",
          tasks: [
            {
              taskId: "TASK1",
              title: "Build blog page",
              persona: "builder",
              priority: 0,
              effort: "medium",
              estimatedTokens: 60000,
              reason: "Matches intent",
              dependencies: [],
              parallel: true,
            },
          ],
          totalTokens: 60000,
        },
      ],
      totalTasks: 1,
      totalTokens: 60000,
      reasoning: "Blog is top priority per intent",
    });

    expect(sprint.id).toBeTruthy();
    expect(sprint.intent).toBe("ship blog and fix bugs");
    expect(sprint.budget).toBe(5);
    expect(sprint.constraints).toEqual(["no more than 2 infra agents"]);
    expect(sprint.groups.length).toBe(1);
    expect(sprint.groups[0].persona).toBe("builder");
    expect(sprint.totalTasks).toBe(1);
    expect(sprint.totalTokens).toBe(60000);

    // Retrieve
    const fetched = store.getSprint(sprint.id);
    expect(fetched).toBeDefined();
    expect(fetched!.intent).toBe("ship blog and fix bugs");
    expect(fetched!.groups[0].tasks[0].taskId).toBe("TASK1");
  });

  it("lists sprints in reverse chronological order", () => {
    store.saveSprint({ intent: "first", budget: 3, groups: [], totalTasks: 0, totalTokens: 0, reasoning: "" });
    store.saveSprint({ intent: "second", budget: 5, groups: [], totalTasks: 0, totalTokens: 0, reasoning: "" });

    const sprints = store.listSprints();
    expect(sprints.length).toBe(2);
    expect(sprints[0].intent).toBe("second");
    expect(sprints[1].intent).toBe("first");
  });

  it("returns undefined for missing sprint", () => {
    expect(store.getSprint("nonexistent")).toBeUndefined();
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      store.saveSprint({ intent: `sprint-${i}`, budget: 1, groups: [], totalTasks: 0, totalTokens: 0, reasoning: "" });
    }

    const sprints = store.listSprints(2);
    expect(sprints.length).toBe(2);
  });

  it("stores template name when provided", () => {
    const sprint = store.saveSprint({
      intent: "bug bash week",
      budget: 8,
      template: "bug-bash",
      groups: [],
      totalTasks: 0,
      totalTokens: 0,
      reasoning: "",
    });

    const fetched = store.getSprint(sprint.id);
    expect(fetched!.template).toBe("bug-bash");
  });
});
