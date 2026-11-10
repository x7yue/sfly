-- 产物记录文件在 Agent 上的修改时间（Agent 时间，#171）；旧版 Agent 不上报、改动之前的产物为空。
ALTER TABLE "artifacts" ADD COLUMN "agent_modified_at" timestamp with time zone;
