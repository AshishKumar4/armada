import Std

/- Durations are integral clock ticks. `start * machines + last ≤ work` is the last-start
   certificate of a work-conserving list schedule on a fixed pool, all jobs ready at zero.
   Releases, gangs, retries and speculative copies are outside the makespan theorems.
   The TypeScript/SQL implementation is checked by behavioural tests, not extracted from Lean. -/
namespace Armada

theorem selected_never_worse (lpt multifit searched : Nat) :
    min lpt (min multifit searched) ≤ lpt := Nat.min_le_left _ _

theorem selected_preserves_bound (lpt multifit searched bound : Nat)
    (h : lpt ≤ bound) : min lpt (min multifit searched) ≤ bound :=
  Nat.le_trans (selected_never_worse _ _ _) h

theorem list_schedule_bound (m start last work optimum : Nat)
    (positive : 0 < m) (busy : m * start + last ≤ work)
    (average : work ≤ m * optimum) (largest : last ≤ optimum) :
    m * (start + last) ≤ (2 * m - 1) * optimum := by
  cases m with
  | zero => omega
  | succ n =>
    have h := Nat.le_trans busy average
    have hp := Nat.mul_le_mul_left n largest
    simp only [Nat.succ_mul, Nat.mul_add, Nat.add_mul] at *
    omega

/- The usual LPT bound follows when the critical task is at most one third of OPT.
   The LPT combinatorial lemma establishing that fact (or optimality otherwise) is NOT proved here. -/
theorem lpt_critical_task_bound (m start last work optimum : Nat)
    (positive : 0 < m) (busy : m * start + last ≤ work)
    (average : work ≤ m * optimum) (critical : 3 * last ≤ optimum) :
    3 * m * (start + last) ≤ (4 * m - 1) * optimum := by
  cases m with
  | zero => omega
  | succ n =>
    have h := Nat.le_trans busy average
    have hc := Nat.mul_le_mul_left n critical
    simp only [Nat.succ_mul, Nat.mul_add, Nat.add_mul] at *
    omega

/- SQL's conditional running→landing→terminal transition appends once; a later accept
   cannot change terminal state. Loss/retry returns to running without appending an outcome. -/
def commit (outcome : Option Nat) (answer : Nat) : Option Nat :=
  match outcome with
  | none => some answer
  | some kept => some kept

theorem first_answer_wins (a b : Nat) : commit (commit none a) b = some a := rfl
theorem terminal_immutable (kept answer : Nat) : commit (some kept) answer = some kept := rfl
theorem exactly_one_record (answer : Nat) : (commit none answer).isSome = true := rfl

def admit (used request cap : Nat) : Nat :=
  if used + request ≤ cap then used + request else used

theorem fleet_cap (used request cap : Nat) (before : used ≤ cap) : admit used request cap ≤ cap := by
  unfold admit
  split <;> omega

/- A backfill's *certified upper runtime*, not its estimate, must fit the reservation.
   Boot and cleanup finish within latency; no later loss, admission denial or preemption occurs. -/
theorem safe_backfill (start actual upper reserved : Nat)
    (runtime : actual ≤ upper) (fits : start + upper ≤ reserved) :
    start + actual ≤ reserved := by omega

theorem gang_start_bounded (reserved latency ready start : Nat)
    (ranks : ready ≤ reserved + latency) (dispatch : start ≤ ready) :
    start ≤ reserved + latency := Nat.le_trans dispatch ranks

/- Weighted least-allocated admission uses cross multiplication of normalized shares.
   This is an admission-point guarantee only, not preemptive wall-clock service fairness. -/
def better (usedA weightA usedB weightB : Nat) : Bool :=
  usedA * weightB ≤ usedB * weightA

theorem weighted_least_allocated (usedA weightA usedB weightB : Nat)
    (chosen : better usedA weightA usedB weightB = true) :
    usedA * weightB ≤ usedB * weightA := by simpa [better] using chosen

def admitting (now expiry : Nat) : Bool := expiry ≤ now
theorem drain_expires (now expiry : Nat) (expired : expiry ≤ now) : admitting now expiry = true := by
  simpa [admitting] using expired

#print axioms selected_never_worse
#print axioms selected_preserves_bound
#print axioms list_schedule_bound
#print axioms lpt_critical_task_bound
#print axioms first_answer_wins
#print axioms terminal_immutable
#print axioms exactly_one_record
#print axioms fleet_cap
#print axioms safe_backfill
#print axioms gang_start_bounded
#print axioms weighted_least_allocated
#print axioms drain_expires
end Armada
