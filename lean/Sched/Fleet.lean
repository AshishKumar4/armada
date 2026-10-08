/-
`Sched.Fleet` — worker/src/fleet.ts's hold ledger.

`ArmadaFleet.acquire` grants `vcpus` to a holder when the sum of the OTHER live
holds plus the ask fits `FLEET_VCPUS`, and stores the live set plus the new
hold — which also evicts any hold whose lease has lapsed. `release` drops the
holder's hold; a hold is `live` while its `expiry` is in the future. The clock
only moves forward.

**Theorem (d)**: over any sequence of operations — `tick` (the clock advances),
`acquire`, `release` — the vCPUs the live holds claim never exceed the cap.
-/
import Sched.Basic

namespace Sched

open List

/-- A hold: vCPUs held until `expiry` (the holder's lease, `now + LEASE_MS`). -/
structure Hold where
  vcpus : Nat
  expiry : Nat

/-- The fleet's shared state: the cap, the clock, the stored holds keyed by holder. -/
structure FleetState where
  cap : Nat
  clock : Nat
  holds : List (Nat × Hold)

/-- `leaseMs`: the lease a hold is written with (`LEASE_MS` in fleet.ts). -/
def leaseMs : Nat := 3 * 60 * 60 * 1000

/-- The holds live at `now`: `live` in fleet.ts filters `expiry > now`. -/
def liveHolds (holds : List (Nat × Hold)) (now : Nat) : List (Nat × Hold) :=
  holds.filter fun h => h.2.expiry > now

/-- The vCPUs the live holds claim (`used` in fleet.ts). -/
def usedOf (holds : List (Nat × Hold)) (now : Nat) : Nat :=
  ((liveHolds holds now).map fun h => h.2.vcpus).sum

/-- `acquire holder v`: granted when the others' live total plus `v` fits the cap;
the stored set becomes the live set plus the holder's fresh lease — so a granted
acquire also evicts the dead, exactly as `ctx.storage.put('holds', …)` does. -/
def acquire (s : FleetState) (holder : Nat) (v : Nat) : Bool × FleetState :=
  if (((liveHolds s.holds s.clock).filter fun h => h.1 ≠ holder).map fun h => h.2.vcpus).sum + v ≤ s.cap then
    (true, { s with holds := (holder, { vcpus := v, expiry := s.clock + leaseMs })
        :: (liveHolds s.holds s.clock).filter fun h => h.1 ≠ holder })
  else (false, s)

/-- `release holder`: the holder's hold is dropped. -/
def release (s : FleetState) (holder : Nat) : FleetState :=
  { s with holds := s.holds.filter fun h => h.1 ≠ holder }

/-- The clock moves forward: live holds only shrink. -/
def tick (s : FleetState) (now : Nat) : FleetState :=
  if s.clock ≤ now then { s with clock := now } else s

/-- The fleet's invariant: live holds never claim more than the cap. -/
def FleetState.Inv (s : FleetState) : Prop := usedOf s.holds s.clock ≤ s.cap

/-- A sublist's mapped sum is smaller. -/
theorem sum_le_sum_sublist {α : Type} (f : α → Nat) {l₁ l₂ : List α} (h : l₁ <+ l₂) :
    (l₁.map f).sum ≤ (l₂.map f).sum := by
  induction h with
  | slnil => simp
  | cons _ _ ih => exact Nat.le_trans ih (Nat.le_add_left _ _)
  | cons_cons _ _ ih => rw [List.map_cons, List.map_cons, List.sum_cons, List.sum_cons]; omega

/-- Filtering by a stronger predicate gives a sublist. -/
theorem filter_sublist_of_imp {α : Type} (l : List α) (p q : α → Bool)
    (h : ∀ x, p x = true → q x = true) : l.filter p <+ l.filter q := by
  induction l with
  | nil => exact List.Sublist.slnil
  | cons a t ih =>
    rw [List.filter_cons, List.filter_cons]
    by_cases hp : p a = true
    · rw [ite_eq_left hp, ite_eq_left (h a hp)]
      exact List.Sublist.cons_cons _ ih
    · rw [ite_eq_right hp]
      by_cases hq : q a = true
      · rw [ite_eq_left hq]
        exact List.Sublist.cons _ ih
      · rw [ite_eq_right hq]
        exact ih

/-- Later times keep a sublist of the live holds. -/
theorem live_sublist (holds : List (Nat × Hold)) (now later : Nat) (h : now ≤ later) :
    liveHolds holds later <+ liveHolds holds now := by
  unfold liveHolds
  apply filter_sublist_of_imp
  intro x hx
  simp at hx ⊢
  omega

/-- The vCPUs a sublist of the live holds claims are smaller. -/
theorem used_le_tick (holds : List (Nat × Hold)) (now later : Nat) (h : now ≤ later) :
    usedOf holds later ≤ usedOf holds now :=
  sum_le_sum_sublist _ (live_sublist holds now later h)

/-- The granted `acquire` leaves the invariant: its live set is the new hold plus
the others' live total, exactly the bound the grant checked. -/
theorem inv_acquire (s : FleetState) (hinv : s.Inv) (holder v : Nat) :
    (acquire s holder v).2.Inv := by
  unfold acquire
  split
  · next h =>
    unfold FleetState.Inv usedOf liveHolds
    simp only [liveHolds] at h
    rw [List.filter_cons]
    have hnew : (decide (((holder, ({ vcpus := v, expiry := s.clock + leaseMs } : Hold))).2.expiry > s.clock)) = true := by
      rw [decide_eq_true_eq]
      show s.clock + leaseMs > s.clock
      unfold leaseMs
      omega
    rw [ite_eq_left hnew, List.map_cons, List.sum_cons]
    show v + ((((s.holds.filter fun x => x.2.expiry > s.clock).filter fun x => x.1 ≠ holder).filter fun x => x.2.expiry > s.clock).map fun h => h.2.vcpus).sum ≤ s.cap
    have hkeep : (((s.holds.filter fun x => x.2.expiry > s.clock).filter fun x => x.1 ≠ holder).filter fun x => x.2.expiry > s.clock)
        = (s.holds.filter fun x => x.2.expiry > s.clock).filter fun x => x.1 ≠ holder := by
      rw [List.filter_filter]
      apply List.filter_congr
      intro x hx
      rw [List.mem_filter] at hx
      rw [hx.2]
      simp
    rw [hkeep]
    omega
  · exact hinv

/-- `release` keeps the invariant: the live holds only shrink. -/
theorem inv_release (s : FleetState) (hinv : s.Inv) (holder : Nat) :
    (release s holder).Inv := by
  unfold FleetState.Inv usedOf liveHolds release
  show (((s.holds.filter fun h => h.1 ≠ holder).filter fun h => h.2.expiry > s.clock).map fun h => h.2.vcpus).sum ≤ s.cap
  rw [List.filter_filter]
  have hsub : (s.holds.filter fun x => decide (x.2.expiry > s.clock) && decide (x.1 ≠ holder)) <+
      (s.holds.filter fun x => decide (x.2.expiry > s.clock)) := by
    apply filter_sublist_of_imp
    intro x hx
    simp at hx ⊢
    exact hx.1
  have := sum_le_sum_sublist (fun h => h.2.vcpus) hsub
  exact Nat.le_trans this hinv

/-- The clock advancing keeps the invariant. -/
theorem inv_tick (s : FleetState) (hinv : s.Inv) (now : Nat) :
    (tick s now).Inv := by
  unfold tick
  split
  · next h =>
    show usedOf s.holds now ≤ s.cap
    exact Nat.le_trans (used_le_tick s.holds s.clock now h) hinv
  · exact hinv

/-- Every fleet operation. -/
inductive FOp where
  | tick : Nat → FOp
  | acquire : Nat → Nat → FOp
  | release : Nat → FOp

/-- One fleet operation applied to the state. -/
def applyF (s : FleetState) : FOp → FleetState
  | .tick now => tick s now
  | .acquire holder v => (acquire s holder v).2
  | .release holder => release s holder

/-- `Inv` survives each operation. -/
theorem inv_fop (s : FleetState) (hinv : s.Inv) (op : FOp) : FleetState.Inv (applyF s op) := by
  cases op with
  | tick now => exact inv_tick s hinv now
  | acquire holder v => exact inv_acquire s hinv holder v
  | release holder => exact inv_release s hinv holder

/-- **Fleet admission**: over any sequence of operations, the live holds' vCPUs
never exceed the cap. -/
theorem fleet_law (cap : Nat) (ops : List FOp) :
    FleetState.Inv (ops.foldl applyF ⟨cap, 0, []⟩) := by
  suffices aux : ∀ (s : FleetState) (rest : List FOp), s.Inv → (rest.foldl applyF s).Inv by
    exact aux ⟨cap, 0, []⟩ ops (by unfold FleetState.Inv usedOf liveHolds; simp)
  intro s rest hs
  induction rest generalizing s with
  | nil => simpa using hs
  | cons op tail ih =>
    rw [List.foldl_cons]
    exact ih _ (inv_fop s hs op)

end Sched
