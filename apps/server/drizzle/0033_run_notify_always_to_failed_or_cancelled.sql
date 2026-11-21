-- 运行通知的触发条件去掉了「总是」（always，#446）：存量的「总是」改成「失败和取消」，读取时不再留兼容分支。
-- 触发条件只存在场景表的这一列里（不属于场景版本），所以历史版本、运行都不受影响，不写会改动已保存版本的语句。
UPDATE "orchestrations" SET "run_notify_trigger" = 'failed_or_cancelled' WHERE "run_notify_trigger" = 'always';
