import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings, Deps } from "../lib/context";
import { adminRoutes } from "./admin/routes";
import { agentsRoutes } from "./agents/routes";
import { appointmentsRoutes } from "./appointments/routes";
import { campaignsRoutes } from "./campaigns/routes";
import { catalogRoutes } from "./catalog/routes";
import { channelsRoutes } from "./channels/routes";
import { contactsRoutes } from "./contacts/routes";
import { conversationsRoutes } from "./conversations/routes";
import { conversationTypingRoutes } from "./conversations/typing";
import { helpRoutes } from "./help/routes";
import { homeRoutes } from "./home/routes";
import { mediaRoutes } from "./media/routes";
import { notificationsRoutes } from "./notifications/routes";
import { onboardingRoutes } from "./onboarding/routes";
import { sessionRoutes } from "./session/routes";
import { settingsRoutes } from "./settings/routes";
import { teamRoutes } from "./team/routes";

/**
 * Registro único de módulos: app.ts só chama isto. Cada módulo exporta `<nome>Routes(deps)`.
 * Montagem explícita (um `route` por módulo): módulos com ambientes diferentes (ex.: admin) não cabem num array.
 */
export function mountModules(app: OpenAPIHono<AppBindings>, deps: Deps) {
  app.route("/v1", sessionRoutes(deps));
  app.route("/v1", onboardingRoutes(deps));
  app.route("/v1", teamRoutes(deps));
  app.route("/v1", channelsRoutes(deps));
  app.route("/v1", contactsRoutes(deps));
  app.route("/v1", appointmentsRoutes(deps));
  app.route("/v1", catalogRoutes(deps));
  app.route("/v1", agentsRoutes(deps));
  app.route("/v1", conversationsRoutes(deps));
  app.route("/v1", conversationTypingRoutes(deps));
  app.route("/v1", campaignsRoutes(deps));
  app.route("/v1", settingsRoutes(deps));
  app.route("/v1", homeRoutes(deps));
  app.route("/v1", helpRoutes(deps));
  app.route("/v1", mediaRoutes(deps));
  app.route("/v1", notificationsRoutes(deps));
  app.route("/v1", adminRoutes(deps));
}
