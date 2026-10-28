import "server-only";
import { homeOverviewSchema, type HomeOverview, type HomePeriod } from "@duckzap/contracts/home";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/home): GET /v1/home/overview, POST /v1/home/tasks, PATCH /v1/home/tasks/:id.
// Os números vêm de conversas, agenda e canais reais; as conversas respeitam a visibilidade da pessoa (view_all) e o
// ranking por atendente só vai para quem tem home.view_team_metrics. O período "custom" ainda não tem seletor de datas
// e vale como 30 dias no servidor.

const taskSchema = homeOverviewSchema.shape.tasks.element;

export async function getHomeOverview(period: HomePeriod): Promise<HomeOverview> {
  return readApi(`/v1/home/overview?period=${encodeURIComponent(period)}`, homeOverviewSchema);
}

export async function createTask(title: string): Promise<Result<HomeOverview["tasks"][number]>> {
  return callApi("/v1/home/tasks", taskSchema, { method: "POST", body: { title }, errors: [] as readonly string[], fallback: "error" });
}

export async function setTaskDone(id: string, done: boolean): Promise<Result<null>> {
  return callApiVoid(`/v1/home/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: { done }, errors: [] as readonly string[], fallback: "error" });
}
