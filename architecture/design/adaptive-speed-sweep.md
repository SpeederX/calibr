# Adaptive speed sweep

The default offload and MoE sweeps seek the measured throughput optimum; they
do not need every point in the slow tail. Candidates remain ordered by their
offload control (`--gpu-layers` or `--n-cpu-moe`) so the runtime can observe
the curve as it approaches and passes its peak.

For every successful baseline config, calibr compares median `eval_tps` with
the best value already observed in the same model and sweep:

- a higher value becomes the new peak;
- a value within 2% of the peak is treated as measurement noise and breaks a
  descending sequence;
- a value more than 2% below the peak counts as descending evidence;
- two consecutive descending points stop the remaining configs in that sweep.

The triggering result records the peak, relation to the peak, descending-point
count, and whether it stopped the sweep. Skipped configs remain visible in the
benchmark summary as an adaptive stop rather than a failure.

This is a runtime optimization, not a change to winner selection. All measured
configs remain eligible under the existing winner policy.

Researchers can retain the complete curve by setting
`planning.speed_sweep.full_curve` to `true` or passing `-FullSpeedCurve` to the
raw workflow. The default guided scopes use adaptive stopping; the future full
matrix scope uses the complete curve.
