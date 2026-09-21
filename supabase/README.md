# 自动查询 Edge Function 部署

本项目使用 DeepSeek Responses API，Base URL 为 `https://api.deepseek.com`，模型固定为 `deepseek-flash`（DeepSeek V4.1 Flash）。前端只有 Supabase Publishable Key；LLM API Key **只能**设置为 Supabase Edge Function Secret，不要写进 `supabase-config.js`、仓库文件或 JSON 备份。

1. 在 Supabase 控制台选择项目 `guhnpxwgdoofontinxap`，打开 **Edge Functions → Secrets**，新增 `DEEPSEEK_API_KEY`，值填写你的 DeepSeek API Key。无需设置模型 Secret。
2. 使用有该项目部署权限的 Supabase CLI 登录后，在仓库根目录执行：

   ```sh
   supabase functions deploy lookup-french --project-ref guhnpxwgdoofontinxap
   ```

3. 保持 `supabase/config.toml` 中的 `verify_jwt = true`。自动查询要求学习账号已登录；查询失败仍可在网站手动填写中文。

Supabase 自动注入 `SUPABASE_URL`，无需添加此 Secret。现有 `words` 表无需迁移：确认添加时只保存中文释义；词性和搭配在确认前供校对参考。请在 LLM 供应商后台设置用量/费用上限。
