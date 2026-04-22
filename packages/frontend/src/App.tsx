import { RouterProvider } from "@tanstack/react-router";
import { useWsConnection } from "@/hooks/use-ws";
import { router } from "./router";

export function App() {
  useWsConnection();
  return <RouterProvider router={router} />;
}
