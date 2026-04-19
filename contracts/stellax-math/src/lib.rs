//! # stellax-math
//!
//! Fixed-point math primitives and protocol-wide constants for StellaX.
//!
//! All financial values inside StellaX use a 128-bit signed integer (`i128`)
//! with **18 decimals of precision** (`PRECISION = 10^18`). Prices coming from
//! oracles are normalized from their native precision (typically 8 decimals
//! for RedStone or 7 decimals for Stellar Classic assets) into 18-decimal
//! internal representation at the contract boundary.
//!
//! ## Modules
//!
//! - [`constants`] — protocol-wide numeric constants (precision, leverage caps, TTL bumps)
//! - [`types`]     — shared `contracttype` data structures (Position, Market, PriceData, …)
//! - [`fixed`]     — fixed-point arithmetic (mul_div, mul_precision, div_precision, conversions)
//! - [`advanced`]  — advanced math (pow, sqrt, exp, ln, normal_cdf for Black-Scholes)
//! - [`bps`]       — basis-point and percentage helpers (apply_bps, apply_haircut, clamp)
//!
//! Every function in this crate is `no_std` compatible and free of floating
//! point operations, as required by the Soroban execution environment.

#![no_std]

pub mod advanced;
pub mod bps;
pub mod constants;
pub mod fixed;
pub mod types;

// Re-export the most-used helpers at crate root for ergonomic call sites
// throughout the contracts.
pub use advanced::{exp_fixed, ln_fixed, normal_cdf, pow, sqrt_fixed};
pub use bps::{apply_bps, apply_haircut, clamp};
pub use constants::*;
pub use fixed::{
    div_precision, div_precision_checked, mul_div, mul_div_checked, mul_precision,
    mul_precision_checked, to_precision, to_precision_checked,
};
pub use types::*;
