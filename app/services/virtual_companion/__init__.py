"""Inert protocol building blocks for the opt-in virtual Companion service.

Importing this package never opens a socket. Listener lifecycle is wired only
by the explicitly enabled integration added in a later stack layer.
"""

from .dispatch import CommandDispatcher
from .server import VirtualCompanionServer

__all__ = ["CommandDispatcher", "VirtualCompanionServer"]
