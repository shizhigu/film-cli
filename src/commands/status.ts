/**
 * film status — show project status dashboard.
 */

import { openDb, getProject, countShotsByStatus } from "../db";
import { emit, table } from "../output";

export function statusCmd(_args: string[]) {
  const db = openDb();
  const project = getProject(db);
  if (!project) {
    console.error("No project found. Run 'film init' first.");
    process.exit(1);
  }

  // Get episodes
  const episodes = db
    .query("SELECT * FROM episodes WHERE project_id = ? ORDER BY number")
    .all(project.id) as Record<string, any>[];

  // Build status data
  const epStats = episodes.map((ep) => {
    const counts = countShotsByStatus(db, ep.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const accepted = counts["accepted"] ?? 0;
    return {
      episode: ep.number,
      title: ep.title ?? "",
      status: ep.status,
      shots: `${accepted}/${total} accepted`,
      ...counts,
    };
  });

  // Get total asset count
  const assetCount = (
    db.query("SELECT COUNT(*) as cnt FROM assets WHERE project_id = ?").get(project.id) as any
  )?.cnt ?? 0;

  const data = {
    project: project.name,
    created: project.created_at,
    episodes: epStats,
    total_assets: assetCount,
  };

  if (episodes.length === 0) {
    emit(data, `Project: ${project.name}\nNo episodes yet. Run 'film episode create 1 --title "..."'`);
  } else {
    emit(data);
    if (!(globalThis as any).__json) {
      console.log(`\nProject: ${project.name}`);
      console.log(`Assets: ${assetCount}`);
      console.log(`Episodes:`);
      table(
        ["#", "Title", "Status", "Shots"],
        epStats.map((e) => [e.episode, e.title, e.status, e.shots])
      );
    }
  }

  db.close();
}
