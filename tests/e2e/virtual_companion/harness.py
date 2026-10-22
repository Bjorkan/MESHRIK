"""Hardware-free meshcore_py smoke harness for the virtual Companion TCP contract."""

import asyncio

from meshcore import MeshCore

from app.services.virtual_companion.identity import (
    CompanionIdentitySnapshot,
    build_identity_dispatcher,
)
from app.services.virtual_companion.server import VirtualCompanionServer


def synthetic_identity() -> CompanionIdentitySnapshot:
    return CompanionIdentitySnapshot(
        generation=1,
        protocol_version=14,
        public_key=bytes.fromhex("22" * 32),
        name="Synthetic Harness Node",
        advert_type=1,
        tx_power=14,
        max_tx_power=22,
        latitude=0,
        longitude=0,
        multi_acks=0,
        advert_location_policy=0,
        telemetry_mode_base=0,
        telemetry_mode_location=0,
        telemetry_mode_environment=0,
        manual_add_contacts=False,
        frequency_mhz=915.0,
        bandwidth_khz=250.0,
        spreading_factor=11,
        coding_rate=5,
        max_contacts=50,
        max_channels=10,
        firmware_build="synthetic",
        device_model="Harness fixture",
        firmware_version="protocol test",
        repeat_enabled=False,
        path_hash_mode=0,
    )


async def main() -> None:
    identity = synthetic_identity()
    server = VirtualCompanionServer(build_identity_dispatcher(lambda: identity))
    await server.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    clients = await asyncio.gather(
        MeshCore.create_tcp("127.0.0.1", port, default_timeout=2),
        MeshCore.create_tcp("127.0.0.1", port, default_timeout=2),
    )
    try:
        if any(client is None for client in clients):
            raise RuntimeError("meshcore_py failed to complete the Companion handshake")
        keys = [client.self_info.get("public_key") for client in clients if client]
        if keys != [identity.public_key.hex(), identity.public_key.hex()]:
            raise RuntimeError("clients did not observe the same synthetic public identity")
        print(f"PASS: meshcore_py connected 2 isolated clients on loopback port {port}")
    finally:
        await asyncio.gather(*(client.disconnect() for client in clients if client))
        await server.stop()


if __name__ == "__main__":
    asyncio.run(main())
