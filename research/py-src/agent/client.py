"""Thin DeepSeek API client.

Deliberately hand-rolled on httpx rather than the OpenAI SDK, because we depend
on DeepSeek-specific extension fields (`thinking`, `reasoning_effort`,
`ori_question`, search `summary`/`authority`) and we want every byte of the
request to be inspectable for cache-prefix stability.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

import httpx

from .config import Settings, estimate_prompt_tokens


class DeepSeekError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


@dataclass
class Usage:
    """Token + cost accounting for one session."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    reasoning_tokens: int = 0
    calls: int = 0
    search_requests: int = 0
    fetch_requests: int = 0
    search_results: int = 0
    latency_ms: float = 0.0
    per_stage: dict[str, dict[str, int]] = field(default_factory=dict)

    def add_completion(self, raw: dict, stage: str = "unknown") -> None:
        u = raw or {}
        self.prompt_tokens += int(u.get("prompt_tokens") or 0)
        self.completion_tokens += int(u.get("completion_tokens") or 0)
        self.cache_hit_tokens += int(u.get("prompt_cache_hit_tokens") or 0)
        self.cache_miss_tokens += int(u.get("prompt_cache_miss_tokens") or 0)
        details = u.get("completion_tokens_details") or {}
        self.reasoning_tokens += int(details.get("reasoning_tokens") or 0)
        self.calls += 1
        bucket = self.per_stage.setdefault(
            stage, {"prompt": 0, "completion": 0, "calls": 0}
        )
        bucket["prompt"] += int(u.get("prompt_tokens") or 0)
        bucket["completion"] += int(u.get("completion_tokens") or 0)
        bucket["calls"] += 1

    @property
    def cache_hit_rate(self) -> float:
        total = self.cache_hit_tokens + self.cache_miss_tokens
        return (self.cache_hit_tokens / total) if total else 0.0

    def as_dict(self) -> dict:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            "cache_hit_tokens": self.cache_hit_tokens,
            "cache_miss_tokens": self.cache_miss_tokens,
            "cache_hit_rate": round(self.cache_hit_rate, 4),
            "reasoning_tokens": self.reasoning_tokens,
            "completion_calls": self.calls,
            "search_requests": self.search_requests,
            "search_results": self.search_results,
            "fetch_requests": self.fetch_requests,
            "latency_ms": round(self.latency_ms, 1),
            "per_stage": self.per_stage,
        }


@dataclass
class ChatResult:
    content: str
    tool_calls: list[dict]
    raw_message: dict
    usage: dict
    finish_reason: str
    latency_ms: float


class DeepSeekClient:
    def __init__(self, settings: Settings, usage: Usage | None = None):
        self.s = settings
        self.usage = usage or Usage()
        self._http = httpx.Client(
            timeout=httpx.Timeout(settings.request_timeout_s, connect=15.0),
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "DeepSeekClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- low level ---------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.s.require_key()}",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, url: str, **kw) -> dict:
        last: Exception | None = None
        for attempt in range(self.s.max_retries):
            try:
                r = self._http.request(method, url, headers=self._headers(), **kw)
                if r.status_code in (408, 429, 500, 502, 503, 504):
                    raise DeepSeekError(
                        f"transient HTTP {r.status_code}", r.status_code, r.text[:400]
                    )
                if r.status_code >= 400:
                    # Other 4xx: do not retry, per API docs.
                    raise DeepSeekError(
                        f"HTTP {r.status_code}: {r.text[:400]}", r.status_code, r.text[:400]
                    )
                return r.json()
            except (httpx.TimeoutException, httpx.TransportError, DeepSeekError) as e:
                status = getattr(e, "status", None)
                if isinstance(e, DeepSeekError) and status and status not in (408, 429, 500, 502, 503, 504):
                    raise
                last = e
                if attempt < self.s.max_retries - 1:
                    time.sleep(min(2 ** attempt, 8) + 0.15 * attempt)
        raise DeepSeekError(f"request failed after {self.s.max_retries} attempts: {last}")

    # -- chat --------------------------------------------------------------

    def chat(
        self,
        messages: list[dict],
        *,
        stage: str = "chat",
        tools: list[dict] | None = None,
        temperature: float = 0.0,
        max_tokens: int = 1_000,
        thinking: bool = False,
        reasoning_effort: str = "medium",
        response_format: dict | None = None,
        strict: bool = False,
    ) -> ChatResult:
        body: dict[str, Any] = {
            "model": self.s.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
            "thinking": {"type": "enabled" if thinking else "disabled"},
        }
        if thinking:
            body["reasoning_effort"] = reasoning_effort
        if tools:
            body["tools"] = _apply_strict(tools) if strict else tools
            body["tool_choice"] = "auto"
        if response_format:
            body["response_format"] = response_format

        base = self.s.beta_base_url if (tools and strict) else self.s.base_url
        started = time.perf_counter()
        data = self._request("POST", f"{base}/chat/completions", json=body)
        latency = (time.perf_counter() - started) * 1000

        self.usage.add_completion(data.get("usage") or {}, stage=stage)
        self.usage.latency_ms += latency

        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        return ChatResult(
            content=(msg.get("content") or "").strip(),
            tool_calls=msg.get("tool_calls") or [],
            raw_message=msg,
            usage=data.get("usage") or {},
            finish_reason=choice.get("finish_reason") or "",
            latency_ms=latency,
        )

    def messages_for_prefix_stability(self, prefix: list[dict]) -> int:
        """Debug helper: estimated tokens of the invariant prefix."""
        return estimate_prompt_tokens(prefix)

    # -- tools -------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        count: int = 8,
        need_content: bool = False,
        ori_question: str | None = None,
        language: str | None = None,
        after: str | None = None,
        before: str | None = None,
    ) -> list[dict]:
        """Single search request. Returns normalised result dicts."""
        q = _compose_query(query, language=language, after=after, before=before)
        payload: dict[str, Any] = {"query": q, "count": max(1, min(50, count))}
        if need_content:
            payload["need_content"] = True
        if ori_question and self.s.use_ori_question:
            payload["ori_question"] = ori_question[:128]

        data = self._request("POST", f"{self.s.base_url}/v1/tools/search", json=payload)
        self.usage.search_requests += 1
        results = data.get("results") or []
        self.usage.search_results += len(results)
        return [_normalise(r) for r in results]

    def fetch(self, url: str) -> dict:
        data = self._request(
            "POST", f"{self.s.base_url}/v1/tools/fetch", json={"url": url}
        )
        self.usage.fetch_requests += 1
        return {
            "url": url,
            "title": data.get("title") or "",
            "content": (data.get("content") or "").strip(),
        }


def _compose_query(
    query: str, *, language: str | None, after: str | None, before: str | None
) -> str:
    parts = [query.strip()]
    if language:
        parts.append(f"lang:{language}")
    if after:
        parts.append(f"after:{after}")
    if before:
        parts.append(f"before:{before}")
    composed = " ".join(p for p in parts if p)
    return composed[:128]


def _normalise(r: dict) -> dict:
    return {
        "title": r.get("title") or "",
        "url": r.get("url") or "",
        "snippet": r.get("snippet") or "",
        "summary": r.get("summary") or "",
        "content": r.get("content") or "",
        "site_name": r.get("site_name"),
        "date": r.get("date"),
        "authority": int(r.get("authority") if r.get("authority") is not None else -1),
        "rerank_score": float(r.get("rerank_score") or 0.0),
    }


def _apply_strict(tools: list[dict]) -> list[dict]:
    out = json.loads(json.dumps(tools))
    for t in out:
        fn = t.get("function") or {}
        fn["strict"] = True
        _enforce_strict_schema(fn.get("parameters") or {})
    return out


def _enforce_strict_schema(schema: dict) -> None:
    """DeepSeek strict mode requires all object props required + no extra props.

    Also strips JSON-Schema keywords the server rejects.
    """
    if not isinstance(schema, dict):
        return
    for banned in ("minLength", "maxLength", "minItems", "maxItems"):
        schema.pop(banned, None)
    if schema.get("type") == "object" or "properties" in schema:
        props = schema.get("properties") or {}
        schema["required"] = sorted(props.keys())
        schema["additionalProperties"] = False
        for v in props.values():
            _enforce_strict_schema(v)
    items = schema.get("items")
    if isinstance(items, dict):
        _enforce_strict_schema(items)
    for key in ("anyOf", "oneOf", "allOf"):
        for sub in schema.get(key) or []:
            if isinstance(sub, dict):
                _enforce_strict_schema(sub)
