import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  loadPageAccessForPosition,
  levelRank,
  isValidPositionLevel,
} from "../src/services/pageAccess";

// Exercises the position page-access engine (4-level + inherit model) against
// the isolated test D1, which has the positions + position_page_access tables
// from migration 094.

async function seedPosition(slug: string, rows: Record<string, string>): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO positions (slug, name, level) VALUES (?, ?, 100)`,
  )
    .bind(slug, slug)
    .run();
  const id = res.meta.last_row_id as number;
  for (const [k, v] of Object.entries(rows)) {
    await env.DB.prepare(
      `INSERT INTO position_page_access (position_id, page_key, level) VALUES (?, ?, ?)`,
    )
      .bind(id, k, v)
      .run();
  }
  return id;
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM position_page_access`);
  await env.DB.exec(`DELETE FROM positions`);
});

describe("position page-access (4-level + inherit)", () => {
  test("levelRank: partial is a rank-1 alias of view", () => {
    expect(levelRank("none")).toBe(0);
    expect(levelRank("view")).toBe(1);
    expect(levelRank("partial")).toBe(1);
    expect(levelRank("edit")).toBe(2);
    expect(levelRank("full")).toBe(3);
  });

  test("isValidPositionLevel rejects legacy 'partial' and junk", () => {
    expect(isValidPositionLevel("none")).toBe(true);
    expect(isValidPositionLevel("view")).toBe(true);
    expect(isValidPositionLevel("edit")).toBe(true);
    expect(isValidPositionLevel("full")).toBe(true);
    expect(isValidPositionLevel("partial")).toBe(false);
    expect(isValidPositionLevel("bogus")).toBe(false);
  });

  test("children inherit parent; explicit child overrides; financials hidden", async () => {
    const id = await seedPosition("sales_exec", {
      team: "view",
      projects: "view",
      "projects.finances": "none",
    });
    const map = await loadPageAccessForPosition(env, id);
    expect(map.team).toBe("view");
    expect(map.projects).toBe("view");
    expect(map["projects.list"]).toBe("view"); // inherited
    expect(map["projects.calendar"]).toBe("view"); // inherited
    expect(map["projects.finances"]).toBe("none"); // explicit override → hidden
    expect(map["service_cases.cases"]).toBe("none"); // unseeded → none
    expect(map.sales).toBe("none");
  });

  test("parent full cascades to all children", async () => {
    const id = await seedPosition("sales_dir", { projects: "full" });
    const map = await loadPageAccessForPosition(env, id);
    expect(map.projects).toBe("full");
    expect(map["projects.list"]).toBe("full");
    expect(map["projects.calendar"]).toBe("full");
    expect(map["projects.finances"]).toBe("full");
  });

  test("narrow grant: parent none + a single child view", async () => {
    const id = await seedPosition("hr", { "projects.calendar": "view" });
    const map = await loadPageAccessForPosition(env, id);
    expect(map.projects).toBe("none");
    expect(map["projects.calendar"]).toBe("view");
    expect(map["projects.list"]).toBe("none");
  });
});
