import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { AppShell } from "./components/layout/AppShell";
import { HomeView } from "./views/HomeView";

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeView,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/session/$sessionId",
  component: lazyRouteComponent(() => import("./views/SessionView"), "SessionView"),
});

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
