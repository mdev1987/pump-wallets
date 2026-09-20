-- Cross-token wallet candidates.
SELECT
  wallet,
  tokens_with_candidates,
  pump_windows_seen,
  pump_windows_led,
  median_lead_seconds,
  median_excess_forward15,
  median_excess_forward30,
  median_excess_forward60,
  median_pump_buy_flow_share,
  median_control_positive30_lift
FROM wallet_global_summary
WHERE tokens_with_candidates >= 3
ORDER BY tokens_with_candidates DESC, pump_windows_led DESC;

-- Wallet behavior by token.
SELECT
  token_ca,
  wallet,
  pumps_led,
  independent_pump_coverage,
  median_seconds_before_pump,
  reliability_adjusted_excess_forward30_median,
  control_positive30_lift,
  median_trade_sol
FROM wallet_token_summary
ORDER BY token_ca, pumps_led DESC, reliability_adjusted_excess_forward30_median DESC NULLS LAST;

-- Inspect the actual pump windows.
SELECT
  token_ca,
  pump_id,
  start_time,
  end_time,
  peak_return,
  buy_sol,
  sell_sol,
  net_buy_sol,
  buy_count
FROM pump_windows
ORDER BY start_timestamp DESC;

-- Inspect individual pump-leading buys.
SELECT
  token_ca,
  wallet,
  pump_id,
  time,
  seconds_before_pump,
  sol_amount,
  price_sol,
  pump_buy_flow_share,
  local_buy_flow_share,
  forward5,
  forward15,
  forward30,
  forward60
FROM pump_buy_events
ORDER BY token_ca, pump_id, seconds_before_pump DESC;

-- DeBot candidates that were followed by a Helius pump window.
SELECT
    d.token_ca,
    d.observed_at_sec,
    d.pump_precursor_score,
    d.buy_pressure_1m,
    d.buy_pressure_delta,
    d.volume_acceleration,
    d.wallet_acceleration,
    t.pump_windows,
    t.strongest_pump_return
FROM debot_signals d
JOIN tokens t USING (token_ca)
WHERE d.is_pump_precursor_candidate
ORDER BY t.strongest_pump_return DESC NULLS LAST, d.pump_precursor_score DESC NULLS LAST;

-- Wallets that repeatedly appear on tokens where DeBot had pump-precursor evidence.
SELECT
    w.wallet,
    COUNT(DISTINCT w.token_ca) AS tokens_seen,
    COUNT(DISTINCT CASE WHEN d.is_pump_precursor_candidate THEN w.token_ca END) AS debot_candidate_tokens,
    SUM(w.pumps_led) AS pump_windows_led,
    median(w.reliability_adjusted_excess_forward30_median) AS median_reliability_adjusted_excess_30
FROM wallet_token_summary w
LEFT JOIN (
    SELECT DISTINCT token_ca
    FROM debot_signals
    WHERE is_pump_precursor_candidate
) d USING (token_ca)
GROUP BY w.wallet
ORDER BY pump_windows_led DESC, debot_candidate_tokens DESC;
