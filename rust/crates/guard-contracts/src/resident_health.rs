//! `ResidentHealth` — wire contract for the resident op that says whether the
//! resident is still serving, and how much room it has left.
//!
//! The existing `health` operation answers `ready` from the evaluation lane, so
//! a saturated resident refuses it with `native_overloaded` exactly as it
//! refuses work. A caller then cannot tell a busy resident from a dead one, and
//! both look like "native unavailable". This operation is routed onto the
//! reserved control lane instead, which keeps a worker and a quarter of the
//! queue out of evaluation capacity: an answer here means the process is alive
//! and authenticating, and the lane figures in it say how loaded it is.
//!
//! Every field is a count, a duration, or a build identifier the runtime
//! already publishes in its capabilities. Nothing here names a path, a command,
//! a request payload or a caller, because the health of the process must be
//! readable by a diagnostic that is not allowed to read the work it is doing.

use serde::{Deserialize, Serialize};

/// Resident feature advertising this op.
pub const RESIDENT_HEALTH_FEATURE: &str = "resident-health-v1";

/// Canonical request budget. The request carries a schema and an identifier, so
/// anything near this bound is malformed.
pub const RESIDENT_HEALTH_MAX_REQUEST_BYTES: usize = 4096;

/// Request schema identifier.
pub const RESIDENT_HEALTH_REQUEST_SCHEMA: &str = "guard-resident-health-request.v1";

/// Result schema identifier.
pub const RESIDENT_HEALTH_RESULT_SCHEMA: &str = "guard-resident-health-result.v1";

/// Request for the serving resident's own health.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResidentHealthRequestV1 {
    /// Must equal [`RESIDENT_HEALTH_REQUEST_SCHEMA`].
    pub schema: String,
    /// Caller-chosen identifier the reply echoes.
    pub request_id: String,
}

/// One dispatch lane's fixed shape.
///
/// Both numbers are decided when the resident starts, so a caller that reads
/// them once knows what a later queue depth is measured against.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResidentLaneV1 {
    /// Worker threads reserved for this lane.
    pub workers: u32,
    /// Requests the lane's queue holds before it answers overload.
    pub queue_capacity: u32,
}

/// Reply carrying the resident's own view of itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResidentHealthResultV1 {
    /// Must equal [`RESIDENT_HEALTH_RESULT_SCHEMA`].
    pub schema: String,
    /// Echo of the request's identifier.
    pub request_id: String,
    /// Digest of the request this reply answers.
    pub request_sha256: String,
    /// Always `serving`. A resident that cannot answer sends no reply at all,
    /// which is the distinction this operation exists to draw.
    pub status: String,
    /// Resident framing protocol version.
    pub protocol_version: u8,
    /// The runtime package version.
    pub runtime_version: String,
    /// The build this resident was compiled from, or `unknown`.
    pub build_sha: String,
    /// `arch-os` of the running binary.
    pub target: String,
    /// How long this resident has been accepting work.
    pub uptime_ms: u64,
    /// The evaluation lane, which carries hook and command work.
    pub evaluation: ResidentLaneV1,
    /// The control lane, which carries metadata work and this operation.
    pub control: ResidentLaneV1,
    /// Requests refused with `native_overloaded` since this resident started.
    /// A rising count beside a `serving` status is a loaded resident, not a
    /// broken one.
    pub overloaded_requests: u64,
}
