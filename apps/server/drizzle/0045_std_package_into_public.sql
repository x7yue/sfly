-- 升级之后经默认项目（或别的项目）发布的标准节点包 sfly-std 版本挪进公共项目（#501）：0032 只挪了当时已有的版本，
-- 之后没写 `--project public` 发布的留在了发布它的项目里。挪完以后公共项目里的名字不能再在别的项目里发布（package-repository.ts）。
UPDATE "node_packages" SET "project_id" = 'public' WHERE "name" = 'sfly-std' AND "project_id" <> 'public';
