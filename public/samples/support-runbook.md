# Support and operations runbook

This runbook is for engineers on the Tidewater support rotation. It describes how incidents are graded, who responds, and what the common device errors mean.

## Severity levels

| Level | Meaning | First response | Customer updates |
| --- | --- | --- | --- |
| SEV1 | Readings unavailable for many customers, or data loss | 15 minutes | Every 30 minutes |
| SEV2 | One customer fully down, or degraded readings for many | 1 hour | Every 2 hours |
| SEV3 | Minor fault with a workaround | Next working day | When resolved |

A SEV1 is declared by the on-call engineer and cannot be downgraded without the incident commander's agreement. Every SEV1 and SEV2 gets a written review within five working days.

## On-call rotation

The rotation is weekly. Handover is on Monday at 10:00 UTC, in a 20-minute call between the outgoing and incoming engineer. The on-call engineer must be able to start work within 15 minutes of a page.

If the on-call engineer does not acknowledge a page within 10 minutes, it escalates to the secondary. After a further 10 minutes it escalates to the engineering manager.

## Device error codes

### E-2201: sensor offline

The device has not reported for more than 10 minutes. Check the gateway's power and cellular signal first. If several devices on one gateway are offline, the gateway is the likely cause. This is handled by the support engineer on call.

### E-3310: low battery

Battery charge is below 15 percent. The device keeps reporting but drops to one reading every 15 minutes. Ask the customer to schedule a battery swap within seven days.

### E-4012: calibration drift

Readings have moved outside the expected range against the reference probe by more than 2 percent for six consecutive hours. The device is still online but its readings should not be trusted. E-4012 is handled by the calibration team, not by general support: open a ticket in the calibration queue and tell the customer that readings since the drift began are flagged as provisional.

### E-5100: firmware mismatch

The device firmware is older than the minimum supported version. Push the current firmware from the fleet console. Devices on firmware older than 3.2 must be updated in two steps, to 3.2 first.

## API limits

The public API allows 600 requests per minute per API key, with a burst allowance of 50 requests per second. Requests over the limit receive HTTP 429 with a Retry-After header. Limits can be raised for a customer by the account team; engineers do not change limits directly.

## Maintenance window

Planned maintenance happens on Sundays between 02:00 and 04:00 UTC. Customers are notified at least 72 hours in advance. No deployments are made on Fridays after 14:00 UTC.

## Data retention

Raw sensor readings are kept for 13 months. Hourly aggregates are kept for seven years. A customer can request deletion of their data, which is completed within 30 days.
