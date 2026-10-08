package config

import "testing"

func TestAgentConfiguration(t *testing.T) {
	c, err := Load(map[string]string{})
	if err != nil || len(c.Agent.Endpoints) != 2 || *c.Agent.DefaultModel != "v_kimi" {
		t.Fatalf("defaults: %v", err)
	}
	c, err = Load(map[string]string{"AGENT_CONFIG": `{"endpoints":[{"id":"custom","label":"Custom","baseUrl":"https://llm.example/v1/","models":["model-a"]}],"defaultEndpointId":"custom","defaultModel":"model-a","budgetChars":4000}`})
	if err != nil || len(c.Agent.Endpoints) != 1 || c.Agent.Endpoints[0].BaseURL != "https://llm.example/v1" || c.Agent.BudgetChars != 4000 {
		t.Fatalf("override: %v", err)
	}
	for _, raw := range []string{`null`, `[]`, `{`, `{"token":"secret"}`, `{"budgetChars":999}`, `{"defaultEndpointId":"missing","defaultModel":"x"}`, `{"authHeader":"Cookie"}`, `{"endpoints":[{"id":"a","label":"A","baseUrl":"http://remote.example/v1","models":["m"]}]}`} {
		if _, err := Load(map[string]string{"AGENT_CONFIG": raw}); err == nil {
			t.Fatalf("accepted invalid config: %s", raw)
		}
	}
}

func TestAgentRuntimeOverrides(t *testing.T) {
	c, err := Load(map[string]string{"AGENT_CONFIG": `{"runtime":{"llm":{"timeoutSec":80},"harness":{"maxLlmCalls":6,"maxParallel":2},"http":{"maxRequestBytes":1024},"memory":{"keepRecent":5}}}`})
	if err != nil || c.Agent.Runtime.Llm.TimeoutSec != 80 || c.Agent.Runtime.Harness.MaxLlmCalls != 6 || c.Agent.Runtime.Harness.MaxParallel != 2 || c.Agent.Runtime.Http.MaxRequestBytes != 1024 || c.Agent.Runtime.Memory.KeepRecent != 5 {
		t.Fatalf("runtime overrides: %v", err)
	}
	for _, raw := range []string{`{"runtime":{"http":{"maxTimeoutSec":0}}}`, `{"runtime":{"harness":{"maxParallel":100}}}`, `{"runtime":{"llm":{"timeoutSec":9999}}}`, `{"runtime":{"llm":{"chat":{"path":"//evil.example"}}}}`, `{"runtime":{"memory":{"keepRecent":100}}}`} {
		if _, err := Load(map[string]string{"AGENT_CONFIG": raw}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestDesktopConfiguration(t *testing.T) {
	c, err := Load(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if c.Desktop.GenaiLoginBrowser != "internal" || c.Desktop.GenaiProxyURL == nil || *c.Desktop.GenaiProxyURL != "http://10.23.5.189:3359" {
		t.Fatalf("desktop SSO defaults: config=%+v, error=%v", c.Desktop, err)
	}
	c, err = Load(map[string]string{"DESKTOP_CONFIG": `{"genaiProxyUrl":null,"genaiLoginBrowser":"internal","genaiInternalConnectPort":47614,"sidecar":{"maxHeapMb":1024}}`})
	if err != nil || c.Desktop.GenaiProxyURL != nil || c.Desktop.Sidecar.MaxHeapMb != 1024 || c.Desktop.GenaiInternalConnectPort != 47614 {
		t.Fatalf("desktop override: %v", err)
	}
	for _, raw := range []string{`null`, `{"secret":"x"}`, `{"sidecar":{"maxHeapMb":1}}`, `{"genaiLoginOrigins":["http://bad.example"]}`, `{"genaiProxyUrl":"http://user:pass@proxy:3359"}`, `{"genaiTimeoutSec":0}`} {
		if _, err := Load(map[string]string{"DESKTOP_CONFIG": raw}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
