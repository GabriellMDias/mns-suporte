import { createRoute, lazyRouteComponent, Link } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { coreRoutes, rootRoute } from "./shell.js";

const identityLinksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ti/vinculos",
  validateSearch(search: Record<string, unknown>): {
    glpiUserId?: number;
    after?: string;
  } {
    const id = typeof search.glpiUserId === "number" ? search.glpiUserId : NaN;
    if (!Number.isSafeInteger(id) || id < 1) return {};
    const cursor =
      typeof search.after === "string" &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(search.after)
        ? search.after
        : undefined;
    return { glpiUserId: id, ...(cursor ? { after: cursor } : {}) };
  },
  component: lazyRouteComponent(
    () => import("./features/identity-links/identity-links.js"),
    "IdentityLinksPage",
  ),
});

function IdentityLinksNavigation() {
  return <Link to="/ti/vinculos">Vínculos de WhatsApp</Link>;
}

export const routeTree = rootRoute.addChildren([
  ...coreRoutes,
  identityLinksRoute,
]);
export const moduleNavigation: readonly ComponentType[] = [
  IdentityLinksNavigation,
];
