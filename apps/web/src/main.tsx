import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter } from "./router";
import "./styles/app.css";

// 纯 SPA（ADR 0006）：构建产物由控制面托管，API 与 SSE 走同源的 /api。
const router = createRouter();
const root = document.getElementById("app");
if (!root) throw new Error("missing #app");

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={router.options.context.queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
