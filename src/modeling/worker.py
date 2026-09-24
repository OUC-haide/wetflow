"""Allowlisted numerical modeling worker.

This process is spawned by the Node modeling service with a single JSON request on
stdin and writes a single JSON response on stdout. It never evaluates user code and
only implements the two documented methods.

For ``monod_batch`` the biomass variable is eliminated from the integrated state:
the state is substrate ``S`` and biomass is reconstructed as ``X = Y * (T - S)``
with ``T = X0 / Y + S0``. The invariant ``X + Y*S = const`` therefore holds by
construction, so even a coarse output step cannot fabricate biomass beyond the
available substrate pool. Internal steps are adaptive and bounded; a request the
solver cannot integrate inside the internal step budget fails loudly instead of
returning an inaccurate or mass-unbalanced trajectory.

For ``growth_fit`` natural-log biomass is regressed on time by ordinary least
squares. ``rSquared`` and ``logRmse`` are fit diagnostics only; no confidence or
prediction interval is computed or implied.
"""

import csv
import json
import math
import sys

MONOD_VERSION = "monod-conservative-rk4-2"
GROWTH_FIT_VERSION = "log-linear-ols-2"

# Adaptive integration controls. A bounded internal step is always used, so the
# requested output ``timeStep`` never controls the integration accuracy directly.
MAX_INTERNAL_STEPS = 2_000_000
MIN_INTERNAL_STEP = 1e-9
MAX_INTERNAL_STEP = 1.0
RTOL = 1e-8
ATOL = 1e-12

# Supported parameter ranges. These keep the double-precision integration inside a
# range where the result stays finite and physically interpretable.
MAX_CONCENTRATION = 1.0e6
MAX_HALF_SATURATION = 1.0e6
MAX_RATE = 1.0e3
MIN_YIELD = 1.0e-6
MAX_YIELD = 1.0e3
MAX_DURATION = 1.0e4
MAX_POOL = 1.0e12
MAX_MEASUREMENT_MAGNITUDE = 1.0e12
MAX_FITTED_EXPONENT = 700.0


def finite(value):
    """True only for real, finite JSON numbers (booleans are not numbers)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def require_finite(value, name, minimum=None, exclusive=False, maximum=None):
    if not finite(value):
        raise ValueError("%s must be a finite number" % name)
    number = float(value)
    if minimum is not None:
        if exclusive and number <= minimum:
            raise ValueError("%s must be greater than %s" % (name, minimum))
        if not exclusive and number < minimum:
            raise ValueError("%s must be at least %s" % (name, minimum))
    if maximum is not None and number > maximum:
        raise ValueError("%s must not exceed %s" % (name, maximum))
    return number


def monod_rate(substrate, mu_max, half_saturation):
    """Specific growth rate mu(S) = muMax * S / (Ks + S); never negative."""
    if substrate <= 0.0:
        return 0.0
    return mu_max * substrate / (half_saturation + substrate)


def substrate_derivative(substrate, mu_max, half_saturation, total):
    """dS/dt for dX/dt = mu(S) X and dS/dt = -(1/Y) mu(S) X with X = Y (T - S).

    Eliminating X gives dS/dt = -mu(S) * (T - S). Both ends of the physical range
    are absorbing guards, so the state can never leave ``[0, T]`` during a step.
    """
    if substrate <= 0.0 or substrate >= total:
        return 0.0
    return -monod_rate(substrate, mu_max, half_saturation) * (total - substrate)


def rk4_step(substrate, step, mu_max, half_saturation, total):
    k1 = substrate_derivative(substrate, mu_max, half_saturation, total)
    k2 = substrate_derivative(substrate + 0.5 * step * k1, mu_max, half_saturation, total)
    k3 = substrate_derivative(substrate + 0.5 * step * k2, mu_max, half_saturation, total)
    k4 = substrate_derivative(substrate + step * k3, mu_max, half_saturation, total)
    return substrate + step * (k1 + 2.0 * k2 + 2.0 * k3 + k4) / 6.0


def integrate_substrate(substrate, target, mu_max, half_saturation, total):
    """Adaptive RK4 (step doubling) from ``substrate`` over ``target`` hours.

    Steps are always clamped to ``[MIN_INTERNAL_STEP, MAX_INTERNAL_STEP]`` and the
    total number of accepted/rejected steps is bounded. Exceeding the bound raises
    instead of returning a partially integrated or inaccurate value.
    """
    if target <= 0.0:
        return substrate
    time = 0.0
    step = min(target, MAX_INTERNAL_STEP)
    steps = 0
    while time < target - 1e-12:
        step = min(step, target - time)
        full = rk4_step(substrate, step, mu_max, half_saturation, total)
        half = rk4_step(substrate, step / 2.0, mu_max, half_saturation, total)
        refined = rk4_step(half, step / 2.0, mu_max, half_saturation, total)
        error = abs(refined - full) / 15.0
        scale = ATOL + RTOL * max(abs(refined), total, 1.0)
        steps += 1
        if steps > MAX_INTERNAL_STEPS:
            raise ValueError(
                "Monod integration exceeded the internal step budget; "
                "reduce duration or loosen the stiffness of the parameters"
            )
        if error <= scale or step <= MIN_INTERNAL_STEP:
            substrate = min(max(refined, 0.0), total)
            time += step
            if error > 0.0:
                growth = 0.9 * math.sqrt(scale / error)
                step = min(step * max(1.0, min(growth, 5.0)), MAX_INTERNAL_STEP)
            else:
                step = min(step * 5.0, MAX_INTERNAL_STEP)
        else:
            step = step * max(0.2, 0.9 * math.sqrt(scale / error))
    return substrate


def run_monod(parameters, budget, csv_path):
    initial_biomass = require_finite(parameters.get("initialBiomass"), "initialBiomass", 0.0, True, MAX_CONCENTRATION)
    initial_substrate = require_finite(parameters.get("initialSubstrate"), "initialSubstrate", 0.0, False, MAX_CONCENTRATION)
    mu_max = require_finite(parameters.get("muMax"), "muMax", 0.0, True, MAX_RATE)
    half_saturation = require_finite(parameters.get("halfSaturation"), "halfSaturation", 0.0, True, MAX_HALF_SATURATION)
    yield_coefficient = require_finite(parameters.get("yield"), "yield", MIN_YIELD, False, MAX_YIELD)
    duration = require_finite(parameters.get("duration"), "duration", 0.0, True, MAX_DURATION)
    time_step = require_finite(parameters.get("timeStep"), "timeStep", 0.0, True, MAX_DURATION)
    if time_step > duration:
        raise ValueError("timeStep must not exceed duration")

    max_rows = budget.get("maxOutputRows")
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or max_rows < 2:
        raise ValueError("maxOutputRows must be an integer of at least 2")

    ratio = duration / time_step
    if not math.isfinite(ratio):
        raise ValueError("Requested trajectory exceeds maxOutputRows")
    steps = int(math.ceil(ratio - 1e-9))
    if steps < 1:
        steps = 1
    output_rows = steps + 1
    if output_rows > max_rows:
        raise ValueError("Requested trajectory exceeds maxOutputRows")

    # Total substrate-equivalent pool T = X0/Y + S0. The pool is finite by the
    # parameter bounds above; guard anyway so a non-finite pool fails explicitly.
    total = initial_biomass / yield_coefficient + initial_substrate
    if not math.isfinite(total) or total > MAX_POOL:
        raise ValueError("initialBiomass/yield + initialSubstrate exceeds the supported pool size")

    substrate = initial_substrate
    rows = [(0.0, initial_biomass, initial_substrate)]
    time = 0.0
    max_biomass = initial_biomass
    for _ in range(1, output_rows):
        step = min(time_step, duration - time)
        substrate = integrate_substrate(substrate, step, mu_max, half_saturation, total)
        time += step
        if time > duration:
            time = duration
        substrate = min(max(substrate, 0.0), total)
        biomass = yield_coefficient * (total - substrate)
        max_biomass = max(max_biomass, biomass)
        rows.append((time, biomass, substrate))

    final_biomass = rows[-1][1]
    final_substrate = rows[-1][2]
    biomass_increase = final_biomass - initial_biomass
    substrate_consumed = initial_substrate - final_substrate
    conservation_residual = (final_biomass - initial_biomass) + yield_coefficient * (final_substrate - initial_substrate)

    with open(csv_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["time_h", "biomass_g_L", "substrate_g_L"])
        for row in rows:
            writer.writerow(["%.12g" % value for value in row])

    summary = {
        "methodVersion": MONOD_VERSION,
        "finalBiomass": final_biomass,
        "finalSubstrate": final_substrate,
        "biomassIncrease": biomass_increase,
        "substrateConsumed": substrate_consumed,
        "maxBiomass": max_biomass,
        "conservationResidual": conservation_residual,
        "growthLimitingSubstrate": final_substrate <= 1e-9 * max(total, 1.0),
        "duration": duration,
        "timeStep": time_step,
        "outputRows": output_rows,
    }
    metrics = {
        "biomassIncrease": biomass_increase,
        "substrateConsumed": substrate_consumed,
        "maxBiomass": max_biomass,
        "conservationResidual": conservation_residual,
    }
    units = {
        "finalBiomass": "g/L",
        "finalSubstrate": "g/L",
        "biomassIncrease": "g/L",
        "substrateConsumed": "g/L",
        "maxBiomass": "g/L",
        "conservationResidual": "g/L",
        "duration": "h",
        "timeStep": "h",
        "outputRows": "rows",
    }
    assumptions = [
        "Well-mixed batch culture at constant temperature with a constant biomass yield Yx/s.",
        "Growth follows Monod kinetics mu = muMax*S/(Ks+S); maintenance, death, inhibition, product formation and feeding are excluded.",
        "Substrate and biomass form one conserved pool, enforced as X + Y*S = X0 + Y*S0 at every reported step.",
    ]
    limitations = [
        "This is an idealized model prediction, not measured evidence and not a validated process model.",
        "Parameters must be justified from independent data; the model cannot identify them.",
        "Other real effects (lag, maintenance, inhibition, multiple substrates) are excluded.",
    ]
    return {
        "method": "monod_batch",
        "methodVersion": MONOD_VERSION,
        "summary": summary,
        "metrics": metrics,
        "units": units,
        "assumptions": assumptions,
        "limitations": limitations,
    }


def run_growth_fit(dataset_rows, csv_path):
    if not isinstance(dataset_rows, list):
        raise ValueError("datasetRows must be a list")
    times = []
    biomasses = []
    for index, row in enumerate(dataset_rows):
        if not isinstance(row, dict):
            raise ValueError("dataset row %d is malformed" % (index + 1))
        time = require_finite(row.get("time"), "time at row %d" % (index + 1))
        biomass = require_finite(row.get("biomass"), "biomass at row %d" % (index + 1), 0.0, True)
        if abs(time) > MAX_MEASUREMENT_MAGNITUDE or biomass > MAX_MEASUREMENT_MAGNITUDE:
            raise ValueError("growth_fit input magnitude is out of the supported range")
        times.append(time)
        biomasses.append(biomass)

    if len(times) < 3:
        raise ValueError("growth_fit requires at least 3 data points")
    if not all(times[i] < times[i + 1] for i in range(len(times) - 1)):
        raise ValueError("growth_fit requires strictly increasing times")
    if len(set(times)) < 3:
        raise ValueError("growth_fit requires at least 3 distinct times")

    count = len(times)
    mean_time = sum(times) / count
    log_biomass = [math.log(value) for value in biomasses]
    mean_log = sum(log_biomass) / count
    denominator = sum((value - mean_time) ** 2 for value in times)
    if denominator <= 0.0:
        raise ValueError("growth_fit requires variation in time")
    slope = sum((time - mean_time) * (value - mean_log) for time, value in zip(times, log_biomass)) / denominator
    intercept = mean_log - slope * mean_time

    fitted = []
    for time in times:
        exponent = intercept + slope * time
        if exponent > MAX_FITTED_EXPONENT:
            raise ValueError("growth_fit fitted biomass overflows the supported range")
        prediction = math.exp(exponent)
        if not math.isfinite(prediction) or prediction <= 0.0:
            raise ValueError("growth_fit produced a non-physical fitted biomass")
        fitted.append(prediction)

    residuals = [log_value - math.log(prediction) for log_value, prediction in zip(log_biomass, fitted)]
    sse = sum(value * value for value in residuals)
    sst = sum((value - mean_log) ** 2 for value in log_biomass)
    log_rmse = math.sqrt(sse / count)
    # rSquared is undefined when every measurement is identical (zero variance):
    # report it as undefined rather than claiming a perfect or a zero fit.
    r_squared = None
    if sst > 0.0:
        r_squared = max(0.0, min(1.0, 1.0 - sse / sst))
    doubling = math.log(2.0) / slope if slope > 0.0 else None

    with open(csv_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["time_h", "observed_biomass_g_L", "fitted_biomass_g_L", "log_residual"])
        for time, observed, prediction, residual in zip(times, biomasses, fitted, residuals):
            writer.writerow(["%.12g" % time, "%.12g" % observed, "%.12g" % prediction, "%.12g" % residual])

    diagnostics = {"logRmse": log_rmse, "n": count}
    if r_squared is not None:
        diagnostics["rSquared"] = r_squared

    summary = {
        "methodVersion": GROWTH_FIT_VERSION,
        "growthRate": slope,
        "doublingTime": doubling,
        "intercept": intercept,
        "n": count,
        "rSquared": r_squared,
        "rSquaredDefined": r_squared is not None,
        "logRmse": log_rmse,
        "fitKind": "exponential-phase log-linear OLS",
    }
    metrics = {"growthRate": slope}
    if doubling is not None:
        metrics["doublingTime"] = doubling
    units = {
        "growthRate": "1/h",
        "doublingTime": "h",
        "intercept": "ln(g/L)",
        "rSquared": "dimensionless",
        "logRmse": "ln(g/L)",
        "n": "points",
    }
    assumptions = [
        "Every supplied point is assumed to lie in one exponential growth phase with no lag, stationary or death phase.",
        "Natural-log biomass is regressed on time by ordinary least squares; residuals are treated as homoscedastic in log space.",
    ]
    limitations = [
        "The exponential phase is selected by the user and is not detected or validated by this worker.",
        "The fit describes the uploaded measurements only; it does not establish a mechanism or predict outside the fitted range.",
        "rSquared and logRmse are fit diagnostics, not confidence or prediction intervals.",
    ]
    uncertainty_note = (
        "No uncertainty interval is computed. rSquared and logRmse are goodness-of-fit diagnostics and must not be "
        "reported as quantified uncertainty or confidence bounds."
    )
    return {
        "method": "growth_fit",
        "methodVersion": GROWTH_FIT_VERSION,
        "summary": summary,
        "metrics": metrics,
        "diagnostics": diagnostics,
        "units": units,
        "assumptions": assumptions,
        "limitations": limitations,
        "uncertaintyNote": uncertainty_note,
    }


def validate_result(result):
    """Local schema gate so the worker never reports success with a malformed payload."""
    if result.get("methodVersion") not in (MONOD_VERSION, GROWTH_FIT_VERSION):
        raise ValueError("unknown method version")
    metrics = result.get("metrics")
    units = result.get("units")
    if not isinstance(metrics, dict) or not metrics:
        raise ValueError("result metrics are missing")
    if not isinstance(units, dict):
        raise ValueError("result units are missing")
    for key, value in metrics.items():
        if not finite(value):
            raise ValueError("metric %s is not finite" % key)
        if not isinstance(units.get(key), str) or not units[key]:
            raise ValueError("metric %s is missing a unit" % key)
    for key, value in result.get("diagnostics", {}).items():
        if not finite(value):
            raise ValueError("diagnostic %s is not finite" % key)
        if not isinstance(units.get(key), str) or not units[key]:
            raise ValueError("diagnostic %s is missing a unit" % key)
    for key, value in result.get("summary", {}).items():
        if isinstance(value, (int, float)) and not isinstance(value, bool) and not math.isfinite(value):
            raise ValueError("summary %s is not finite" % key)
    return result


def run(request):
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    method = request.get("method")
    parameters = request.get("parameters")
    budget = request.get("budget")
    csv_path = request.get("csvPath")
    if not isinstance(parameters, dict):
        raise ValueError("parameters must be an object")
    if not isinstance(budget, dict):
        raise ValueError("budget must be an object")
    if not isinstance(csv_path, str) or not csv_path:
        raise ValueError("csvPath is required")
    if method == "monod_batch":
        result = run_monod(parameters, budget, csv_path)
    elif method == "growth_fit":
        result = run_growth_fit(request.get("datasetRows"), csv_path)
    else:
        raise ValueError("unsupported method")
    return validate_result(result)


def main():
    try:
        request = json.load(sys.stdin)
        response = run(request)
        sys.stdout.write(json.dumps(response, allow_nan=False))
        sys.stdout.flush()
    except Exception as error:  # noqa: BLE001 - the message is the protocol
        sys.stdout.write(json.dumps({"error": str(error)}, allow_nan=False))
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
