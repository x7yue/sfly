import { defineConfig } from "drizzle-kit";

// `pnpm --filter @sfly/server db:generate --name <描述>`：根据 src/db/schema.ts 生成迁移到 drizzle/。
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
});
