"""minimi — a single-tool (web search) research chat agent on DeepSeek Flash."""

from .agent import Agent, Conversation, WEB_SEARCH_TOOL, build_agent
from .client import DeepSeekClient, Usage
from .config import Settings, estimate_prompt_tokens, estimate_tokens

__all__ = [
    "Agent",
    "Conversation",
    "DeepSeekClient",
    "Usage",
    "Settings",
    "WEB_SEARCH_TOOL",
    "build_agent",
    "estimate_tokens",
    "estimate_prompt_tokens",
]
__version__ = "0.1.0"
