package config

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

type LlmOperation struct {
	Method       string            `json:"method"`
	Path         string            `json:"path"`
	Body         json.RawMessage   `json:"body"`
	OkStatus     []int             `json:"okStatus,omitempty"`
	ResponsePath string            `json:"responsePath,omitempty"`
	ExtraHeaders map[string]string `json:"extraHeaders,omitempty"`
}
type LlmRuntime struct {
	Verify     LlmOperation `json:"verify"`
	Chat       LlmOperation `json:"chat"`
	TimeoutSec int          `json:"timeoutSec"`
}
type HarnessRuntime struct {
	ResearcherMaxSteps int `json:"researcherMaxSteps"`
	MaxLlmCalls        int `json:"maxLlmCalls"`
	MaxToolCalls       int `json:"maxToolCalls"`
	DeadlineMs         int `json:"deadlineMs"`
	MaxParallel        int `json:"maxParallel"`
	InlineChars        int `json:"inlineChars"`
	ReadChars          int `json:"readChars"`
	StoreChars         int `json:"storeChars"`
	CompactAtChars     int `json:"compactAtChars"`
	MaxNudges          int `json:"maxNudges"`
	RepeatLimit        int `json:"repeatLimit"`
	FailStreakLimit    int `json:"failStreakLimit"`
	MaxSteps           int `json:"maxSteps"`
	SubagentMaxSteps   int `json:"subagentMaxSteps"`
	SubagentChars      int `json:"subagentChars"`
}
type HttpRuntime struct {
	ConnectTimeoutSec int `json:"connectTimeoutSec"`
	DefaultTimeoutSec int `json:"defaultTimeoutSec"`
	MaxTimeoutSec     int `json:"maxTimeoutSec"`
	MaxRequestBytes   int `json:"maxRequestBytes"`
	MaxResponseBytes  int `json:"maxResponseBytes"`
	MaxPathChars      int `json:"maxPathChars"`
}
type MemoryRuntime struct {
	KeepRecent         int `json:"keepRecent"`
	SummarizeAfter     int `json:"summarizeAfter"`
	PreambleChars      int `json:"preambleChars"`
	MessageChars       int `json:"messageChars"`
	SummaryInputChars  int `json:"summaryInputChars"`
	SummaryOutputChars int `json:"summaryOutputChars"`
}
type OpenMetadataRuntime struct {
	AllowedTools    []string `json:"allowedTools"`
	ProtocolVersion string   `json:"protocolVersion"`
	TimeoutSec      int      `json:"timeoutSec"`
}
type AgentRuntime struct {
	Llm          LlmRuntime          `json:"llm"`
	Harness      HarnessRuntime      `json:"harness"`
	Http         HttpRuntime         `json:"http"`
	OpenMetadata OpenMetadataRuntime `json:"openMetadata"`
	Memory       MemoryRuntime       `json:"memory"`
}

func (c AgentRuntime) validate() error {
	bad := func() error { return fmt.Errorf("AGENT_CONFIG.runtime: invalid settings") }
	for _, group := range []any{c.Harness, c.Http, c.Memory} {
		v := reflect.ValueOf(group)
		for i := 0; i < v.NumField(); i++ {
			n := v.Field(i).Int()
			if (n < 1 && v.Type().Field(i).Name != "MaxNudges") || n < 0 || n > 64<<20 {
				return bad()
			}
		}
	}
	if c.Harness.MaxLlmCalls < 2 || c.Harness.MaxLlmCalls > 100 || c.Harness.MaxToolCalls > 500 || c.Harness.MaxParallel > 32 || c.Harness.DeadlineMs > 900000 || c.Harness.ResearcherMaxSteps > 100 || c.Harness.MaxSteps > 100 || c.Harness.SubagentMaxSteps > 100 || c.Harness.RepeatLimit < 2 || c.Harness.StoreChars < c.Harness.InlineChars || c.Memory.KeepRecent > c.Memory.SummarizeAfter {
		return bad()
	}
	if c.Http.MaxRequestBytes > 16<<20 || c.Http.MaxResponseBytes > 64<<20 || c.Http.MaxPathChars > 4096 || c.Http.MaxTimeoutSec > 900 || c.Http.ConnectTimeoutSec > c.Http.MaxTimeoutSec || c.Http.DefaultTimeoutSec > c.Http.MaxTimeoutSec || c.Llm.TimeoutSec < 1 || c.Llm.TimeoutSec > c.Http.MaxTimeoutSec || c.OpenMetadata.TimeoutSec < 1 || c.OpenMetadata.TimeoutSec > c.Http.MaxTimeoutSec {
		return bad()
	}
	for _, op := range []LlmOperation{c.Llm.Verify, c.Llm.Chat} {
		if op.Method != "POST" && op.Method != "GET" {
			return bad()
		}
		if op.Path != "" && (!strings.HasPrefix(op.Path, "/") || strings.HasPrefix(op.Path, "//") || strings.ContainsAny(op.Path, "?#\\ \t\n") || strings.Contains(op.Path, "..") || len(op.Path) > c.Http.MaxPathChars) {
			return bad()
		}
		for k, v := range op.ExtraHeaders {
			if !strings.EqualFold(k, "Content-Type") && !strings.EqualFold(k, "Accept") || strings.ContainsAny(v, "\r\n") {
				return bad()
			}
		}
	}
	if len(c.Llm.Verify.OkStatus) == 0 || c.Llm.Chat.ResponsePath == "" || c.OpenMetadata.ProtocolVersion == "" || len(c.OpenMetadata.AllowedTools) > 32 {
		return bad()
	}
	for _, status := range c.Llm.Verify.OkStatus {
		if status < 200 || status > 299 {
			return bad()
		}
	}
	for _, tool := range c.OpenMetadata.AllowedTools {
		if tool == "" || len(tool) > 100 {
			return bad()
		}
	}
	return nil
}
