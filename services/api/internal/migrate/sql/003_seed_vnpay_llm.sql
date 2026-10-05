-- Seed the internal VNPAY AI gateway endpoints (OpenAI-compatible, data stays inside VNPAY) when nothing is configured yet.
-- Admins can still change them through PUT /agent/settings. Pair with deploy/llm-mapping.vnpay.json.
UPDATE agent_settings SET
  endpoints = '[
    {"id":"vnpay-kimi","label":"VNPAY · Kimi","baseUrl":"https://genai.vnpay.vn/aigateway/llm_kimi/v1","models":["v_kimi"],"description":"Gateway nội bộ VNPAY — mặc định, không gửi data ra ngoài"},
    {"id":"vnpay-minimax","label":"VNPAY · MiniMax","baseUrl":"https://genai.vnpay.vn/aigateway/llm_minimax/v1","models":["v_minimax27"],"description":"Gateway nội bộ VNPAY — không gửi data ra ngoài"}
  ]'::jsonb,
  default_endpoint_id = 'vnpay-kimi',
  default_model = 'v_kimi'
WHERE id = 1 AND endpoints = '[]'::jsonb;
