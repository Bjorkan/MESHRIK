"""S03 singleton configuration and listener lifecycle tests."""

import asyncio
import inspect
import sqlite3
from unittest.mock import patch

import aiosqlite
import pytest
from fastapi import HTTPException

from app.fanout.manager import FanoutManager
from app.fanout.virtual_companion_tcp import (
    NETWORK_WARNING,
    VirtualCompanionTcpModule,
)
from app.repository.fanout import FanoutConfigRepository
from app.routers.fanout import (
    FanoutConfigCreate,
    FanoutConfigUpdate,
    _enforce_scope,
    _validate_and_normalize_config,
    create_fanout_config,
    update_fanout_config,
)


def virtual_config(**overrides):
    return {
        "bind_host": "127.0.0.1",
        "port": 4001,
        "unsafe_network_acknowledged": False,
        "secure_access": "",
        "virtual_channel_capacity": 40,
        "channel_slots": [],
        **overrides,
    }


def test_virtual_listener_config_defaults_to_loopback_and_has_no_fanout_scope():
    assert _validate_and_normalize_config("virtual_companion_tcp", {}) == virtual_config()
    assert _validate_and_normalize_config(
        "virtual_companion_tcp", {"bind_host": "localhost", "port": 4010}
    ) == virtual_config(port=4010)
    assert _enforce_scope("virtual_companion_tcp", {"messages": "all"}) == {
        "messages": "none",
        "raw_packets": "none",
    }


@pytest.mark.parametrize(
    "config,detail",
    [
        ({"bind_host": "companion.example"}, "literal"),
        ({"bind_host": "0.0.0.0"}, "unsafe_network_acknowledged"),
        (
            {"bind_host": "192.0.2.10", "unsafe_network_acknowledged": True},
            "secure_access",
        ),
        ({"port": 0}, "between 1 and 65535"),
        ({"port": True}, "integer"),
        ({"tls": True}, "Unsupported"),
    ],
)
def test_virtual_listener_rejects_unsafe_or_illusory_config(config, detail):
    with pytest.raises(HTTPException) as exc_info:
        _validate_and_normalize_config("virtual_companion_tcp", config)
    assert exc_info.value.status_code == 400
    assert detail in exc_info.value.detail


def test_non_loopback_requires_explicit_real_access_layer():
    config = _validate_and_normalize_config(
        "virtual_companion_tcp",
        {
            "bind_host": "192.0.2.10",
            "port": 4001,
            "unsafe_network_acknowledged": True,
            "secure_access": "vpn",
        },
    )
    assert config == virtual_config(
        bind_host="192.0.2.10",
        unsafe_network_acknowledged=True,
        secure_access="vpn",
    )


@pytest.mark.asyncio
async def test_concurrent_creates_are_transactionally_singleton_and_default_off(test_db):
    async def create(name):
        return await create_fanout_config(
            FanoutConfigCreate(type="virtual_companion_tcp", name=name)
        )

    results = await asyncio.gather(create("first"), create("second"), return_exceptions=True)
    created = [result for result in results if not isinstance(result, Exception)]
    errors = [result for result in results if isinstance(result, HTTPException)]
    assert len(created) == 1
    assert created[0]["enabled"] is False
    assert len(errors) == 1
    assert errors[0].status_code == 409
    rows = [
        row
        for row in await FanoutConfigRepository.get_all()
        if row["type"] == "virtual_companion_tcp"
    ]
    assert len(rows) == 1
    assert rows[0]["enabled"] is False
    status = FanoutManager().get_statuses()[rows[0]["id"]]
    assert status["status"] == "disabled"
    assert status["clients"] == 0
    assert status["network_warning"] == NETWORK_WARNING


@pytest.mark.asyncio
async def test_migration_retains_one_pre_release_row_and_adds_unique_guard():
    from app.migrations._069_virtual_companion_singleton import migrate

    conn = await aiosqlite.connect(":memory:")
    try:
        await conn.execute(
            """CREATE TABLE fanout_configs (
                id TEXT PRIMARY KEY, type TEXT, created_at INTEGER
            )"""
        )
        await conn.executemany(
            "INSERT INTO fanout_configs(id,type,created_at) VALUES(?,?,?)",
            [("later", "virtual_companion_tcp", 2), ("first", "virtual_companion_tcp", 1)],
        )
        await migrate(conn)
        rows = await (await conn.execute("SELECT id FROM fanout_configs")).fetchall()
        assert rows == [("first",)]
        with pytest.raises(sqlite3.IntegrityError):
            await conn.execute(
                "INSERT INTO fanout_configs(id,type,created_at) VALUES(?,?,?)",
                ("duplicate", "virtual_companion_tcp", 3),
            )
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_listener_reports_clients_and_stops_only_virtual_sessions():
    module = VirtualCompanionTcpModule("test", virtual_config(port=0), name="Virtual Companion")
    with patch("app.fanout.base._broadcast_fanout_health"):
        await module.start()
    port = module._server.sockets[0].getsockname()[1]
    _reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        for _ in range(20):
            if module._server.client_count == 1:
                break
            await asyncio.sleep(0.01)
        assert module.status == "listening"
        assert module.status_details["clients"] == 1
        assert module.status_details["network_warning"] == NETWORK_WARNING
        sessions = module.status_details["client_sessions"]
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "session-1"
        assert sessions[0]["status"] == "connected"
        assert sessions[0]["identity_verified"] is False
        assert "remote" not in sessions[0]
        assert "address" not in sessions[0]
        assert "ip" not in sessions[0]
    finally:
        await module.stop()
        writer.close()
        await writer.wait_closed()
    assert module.status == "disabled"
    assert module.status_details["clients"] == 0


@pytest.mark.asyncio
async def test_client_status_tracks_multiple_connections_and_reconnects():
    module = VirtualCompanionTcpModule("test", virtual_config(port=0), name="Virtual Companion")
    with patch("app.fanout.base._broadcast_fanout_health"):
        await module.start()
    port = module._server.sockets[0].getsockname()[1]
    _reader_one, writer_one = await asyncio.open_connection("127.0.0.1", port)
    _reader_two, writer_two = await asyncio.open_connection("127.0.0.1", port)
    writer_three = None
    try:
        for _ in range(20):
            if module._server.client_count == 2:
                break
            await asyncio.sleep(0.01)
        assert [row["session_id"] for row in module.status_details["client_sessions"]] == [
            "session-1",
            "session-2",
        ]

        writer_one.close()
        await writer_one.wait_closed()
        for _ in range(20):
            if module._server.client_count == 1:
                break
            await asyncio.sleep(0.01)
        _reader_three, writer_three = await asyncio.open_connection("127.0.0.1", port)
        for _ in range(20):
            if module._server.client_count == 2:
                break
            await asyncio.sleep(0.01)
        assert [row["session_id"] for row in module.status_details["client_sessions"]] == [
            "session-2",
            "session-3",
        ]
    finally:
        await module.stop()
        writer_two.close()
        if writer_three is not None:
            writer_three.close()
        await writer_two.wait_closed()
        if writer_three is not None:
            await writer_three.wait_closed()


def test_status_exposes_only_a_verified_public_identity():
    module = VirtualCompanionTcpModule("test", virtual_config(port=0), name="Virtual Companion")
    with patch(
        "app.fanout.virtual_companion_tcp.get_identity_snapshot",
        return_value=type("Identity", (), {"public_key": bytes.fromhex("ab" * 32)})(),
    ):
        assert module.status_details["identity_status"] == "verified"
        assert module.status_details["identity_public_key"] == "ab" * 32


@pytest.mark.asyncio
async def test_failed_enable_rolls_back_config_without_orphan_listener(test_db):
    blocker = await asyncio.start_server(lambda _r, _w: None, "127.0.0.1", 0)
    port = blocker.sockets[0].getsockname()[1]
    cfg = await FanoutConfigRepository.create(
        config_type="virtual_companion_tcp",
        name="Virtual Companion",
        config=virtual_config(port=port),
        scope={"messages": "none", "raw_packets": "none"},
        enabled=False,
    )
    try:
        with patch("app.fanout.base._broadcast_fanout_health"):
            with pytest.raises(HTTPException) as exc_info:
                await update_fanout_config(cfg["id"], FanoutConfigUpdate(enabled=True))
        assert exc_info.value.status_code == 409
        restored = await FanoutConfigRepository.get(cfg["id"])
        assert restored is not None and restored["enabled"] is False
    finally:
        blocker.close()
        await blocker.wait_closed()


@pytest.mark.asyncio
async def test_concurrent_reloads_leave_exactly_one_listener(test_db):
    cfg = await FanoutConfigRepository.create(
        config_type="virtual_companion_tcp",
        name="Virtual Companion",
        config=virtual_config(port=0),
        scope={"messages": "none", "raw_packets": "none"},
        enabled=True,
    )
    manager = FanoutManager()
    with patch("app.fanout.base._broadcast_fanout_health"):
        assert await asyncio.gather(
            manager.reload_config(cfg["id"]), manager.reload_config(cfg["id"])
        ) == [None, None]
    assert len(manager._modules) == 1
    module = manager._modules[cfg["id"]][0]
    assert isinstance(module, VirtualCompanionTcpModule)
    assert len(module._server.sockets) == 1
    status = manager.get_statuses()[cfg["id"]]
    assert status["status"] == "listening"
    assert status["clients"] == 0
    await manager.stop_all()


def test_lifecycle_adapter_has_no_radio_or_fanout_event_handler_path():
    source = inspect.getsource(VirtualCompanionTcpModule)
    assert ".meshcore" not in source.lower()
    assert "radio_runtime" not in source
    assert "run_radio_command" not in source
    for name in ("on_message", "on_raw", "on_contact", "on_telemetry", "on_health"):
        assert name not in VirtualCompanionTcpModule.__dict__
