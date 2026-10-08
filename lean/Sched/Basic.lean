/-!
The dispatcher armada runs, as `src/dispatch.ts` has it: every task in the given order onto the
least-loaded machine (ties: the lowest index), each machine starting at its release. Integer
milliseconds throughout, so `listSchedule` here and in TypeScript agree exactly.
-/
namespace Sched

/-- The index of the least-loaded machine: the first reaching the minimum load, or 0 on an empty
fleet (which the caller never passes). Matches `loads[i] < loads[least]` in src/dispatch.ts. -/
def argLeastLoad (loads : List Nat) : Nat :=
  match loads.min? with
  | some lo => loads.idxOf lo
  | none => 0

/-- One scheduling step over `(loads, lanes)`: task `idx` of duration `d` joins the least-loaded
machine's lane and adds to its load. -/
def assign (loads : List Nat) (lanes : List (List Nat)) (idx d : Nat) : List Nat × List (List Nat) :=
  let m := argLeastLoad loads
  (loads.set m (loads.getD m 0 + d), lanes.set m (lanes.getD m [] ++ [idx]))

/-- The schedule `listSchedule` builds, tasks taken in queue order from index `offset`: per-machine
lanes of task indices, and per-machine loads. -/
def scheduleFrom (loads : List Nat) (lanes : List (List Nat)) (offset : Nat) : List Nat → List (List Nat) × List Nat
  | [] => (lanes, loads)
  | d :: ds =>
    let (loads', lanes') := assign loads lanes offset d
    scheduleFrom loads' lanes' (offset + 1) ds

/-- `listSchedule` itself: `lanes`, `loads`, `makespan` for `durations` over `releases`. -/
def listSchedule (releases : List Nat) (durations : List Nat) : List (List Nat) × List Nat × Nat :=
  let (lanes, loads) := scheduleFrom releases (releases.map fun _ => []) 0 durations
  (lanes, loads, loads.max?.getD 0)

section proofs
open List

/-- `argLeastLoad` names a machine whenever there is one. -/
theorem argLeastLoad_lt (loads : List Nat) (h : loads ≠ []) : argLeastLoad loads < loads.length := by
  unfold argLeastLoad
  cases hmin : loads.min? with
  | none => simp [List.min?_eq_none_iff] at hmin; simp [hmin] at h
  | some lo =>
    simp only
    exact List.idxOf_lt_length_iff.mpr (List.min?_eq_some_iff.mp hmin).1

/-- The least-loaded machine's load is the minimum: every machine loads at least as much. -/
theorem leastLoad_le (loads : List Nat) (h : loads ≠ []) (j : Nat) (hj : j < loads.length) :
    loads.getD (argLeastLoad loads) 0 ≤ loads.getD j 0 := by
  unfold argLeastLoad
  cases hmin : loads.min? with
  | none => simp [List.min?_eq_none_iff] at hmin; simp [hmin] at h
  | some lo =>
    simp only
    have ⟨hmem, hmin'⟩ := List.min?_eq_some_iff.mp hmin
    have hlt : loads.idxOf lo < loads.length := List.idxOf_lt_length_iff.mpr hmem
    have hget : loads[loads.idxOf lo]'(hlt) = lo := List.getElem_idxOf _
    have hgetD : loads.getD (loads.idxOf lo) 0 = lo := by
      rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hlt, hget]; rfl
    rw [hgetD, List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hj]
    exact hmin' _ (List.getElem_mem hj)

/-- `length * b ≤ sum` when `b` bounds the list below elementwise. -/
theorem length_mul_le_sum_of_le (l : List Nat) (b : Nat) (hb : ∀ x ∈ l, b ≤ x) : l.length * b ≤ l.sum := by
  induction l with
  | nil => simp
  | cons a t ih =>
    rw [List.sum_cons, List.length_cons, Nat.succ_mul]
    have := ih (fun x hx => hb x (List.mem_cons_of_mem _ hx))
    have hb' := hb a List.mem_cons_self
    omega

/-- `sum ≤ length * b` when `b` bounds the list above elementwise. -/
theorem sum_le_length_mul_of_le (l : List Nat) (b : Nat) (hb : ∀ x ∈ l, x ≤ b) : l.sum ≤ l.length * b := by
  induction l with
  | nil => simp
  | cons a t ih =>
    rw [List.sum_cons, List.length_cons, Nat.succ_mul]
    have := ih (fun x hx => hb x (List.mem_cons_of_mem _ hx))
    have hb' := hb a List.mem_cons_self
    omega

/-- A nonempty list sums to at least `length` copies of its least-loaded machine's load. -/
theorem length_mul_least_le_sum (loads : List Nat) (h : loads ≠ []) :
    loads.length * loads.getD (argLeastLoad loads) 0 ≤ loads.sum :=
  length_mul_le_sum_of_le loads _ fun x hx => by
    obtain ⟨j, hj, rfl⟩ := List.mem_iff_getElem.mp hx
    simpa [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hj] using leastLoad_le loads h j hj

/-- The list `l` split at index `i`: `l = take i l ++ l[i] :: drop (i+1) l`. -/
theorem take_append_cons_drop {α : Type} (l : List α) (i : Nat) (hi : i < l.length) :
    l = l.take i ++ l[i] :: l.drop (i + 1) := by
  have := List.take_append_drop i l
  rw [List.drop_eq_getElem_cons hi] at this
  exact this.symm

/-- Assigning a task adds its duration to the fleet's total load. -/
theorem sum_assign (loads : List Nat) (lanes : List (List Nat)) (i d : Nat) (h : loads ≠ []) :
    (assign loads lanes i d).1.sum = loads.sum + d := by
  unfold assign
  simp only
  have hm : argLeastLoad loads < loads.length := argLeastLoad_lt loads h
  rw [List.set_eq_take_append_cons_drop, ite_eq_left hm]
  have hdecomp : loads.sum = (loads.take (argLeastLoad loads) ++ loads[argLeastLoad loads] :: loads.drop (argLeastLoad loads + 1)).sum :=
    congrArg List.sum (take_append_cons_drop loads (argLeastLoad loads) hm)
  rw [List.sum_append, List.sum_cons, hdecomp, List.sum_append, List.sum_cons]
  rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hm]
  simp only [Option.getD_some]
  omega

/-- `getD` over `set`: the set index reads the new value inside the list, others read through. -/
theorem getD_set (l : List Nat) (i j : Nat) (a : Nat) :
    (l.set i a).getD j 0 = if i = j then (if i < l.length then a else 0) else l.getD j 0 := by
  rw [List.getD_eq_getElem?_getD, List.getElem?_set]
  split
  · next hij =>
    split
    · next hi => simp
    · next hi => simp
  · next hij => rw [List.getD_eq_getElem?_getD]

/-- Every member of a nonempty list is at most its maximum. -/
theorem le_max_of_mem (l : List Nat) (h : l ≠ []) (x : Nat) (hx : x ∈ l) : x ≤ l.max?.getD 0 := by
  obtain ⟨m, hm⟩ : ∃ m, l.max? = some m := by
    cases hm' : l.max? with
    | none => exact absurd (List.max?_eq_none_iff.mp hm') h
    | some m => exact ⟨m, rfl⟩
  have ⟨_, ub⟩ := List.max?_eq_some_iff.mp hm
  rw [hm]; exact ub _ hx

/-- The maximum of a nonempty list is one of its members. -/
theorem max_mem (l : List Nat) (h : l ≠ []) : ∃ (i : Nat), ∃ (hi : i < l.length), l[i]'hi = l.max?.getD 0 := by
  obtain ⟨m, hm⟩ : ∃ m, l.max? = some m := by
    cases hm' : l.max? with
    | none => exact absurd (List.max?_eq_none_iff.mp hm') h
    | some m => exact ⟨m, rfl⟩
  have ⟨hmem, _⟩ := List.max?_eq_some_iff.mp hm
  obtain ⟨i, hi, hget⟩ := List.mem_iff_getElem.mp hmem
  exact ⟨i, hi, by rw [hm]; exact hget⟩

/-- `max` is monotone under appending. -/
theorem max_le_max_append (l : List Nat) (x : Nat) :
    l.max?.getD 0 ≤ (l ++ [x]).max?.getD 0 := by
  by_cases hne : l = []
  · simp [hne]
  · obtain ⟨i, hi, hget⟩ := max_mem l hne
    have hmem : l[i] ∈ l ++ [x] := List.mem_append_left _ (List.getElem_mem hi)
    have hle := le_max_of_mem (l ++ [x]) (by simp) l[i] hmem
    rwa [← hget]

/-- `m·x` splits as `(m-1)·x + x` for a nonempty fleet. -/
theorem mul_succ_sub (m x : Nat) (hm : 0 < m) : m * x = (m - 1) * x + x := by
  obtain ⟨n, rfl⟩ : ∃ n, m = n + 1 := ⟨m - 1, by omega⟩
  simp [Nat.succ_mul, Nat.add_comm]

/-- The scheduling step's bound: after `d` joins the least-loaded machine `m`, every machine `j`'s
load stays within `assigned + (m-1)·pmax + m·R`, `S` the releases' total (`≤ m·R`). -/
theorem assign_bound
    (S R : Nat) (seen : List Nat) (loads : List Nat) (lanes : List (List Nat)) (idx d : Nat)
    (hne : loads ≠ [])
    (hS : S ≤ loads.length * R) (hsum : loads.sum = S + seen.sum)
    (hinv : ∀ j, j < loads.length →
      loads.length * loads.getD j 0 ≤ seen.sum + (loads.length - 1) * seen.max?.getD 0 + loads.length * R) :
    ∀ j, j < (assign loads lanes idx d).1.length →
      (assign loads lanes idx d).1.length * (assign loads lanes idx d).1.getD j 0 ≤
        (seen ++ [d]).sum + ((assign loads lanes idx d).1.length - 1) * (seen ++ [d]).max?.getD 0 + (assign loads lanes idx d).1.length * R := by
  intro j hj
  unfold assign at hj ⊢
  simp only at hj ⊢
  have hm : argLeastLoad loads < loads.length := argLeastLoad_lt loads hne
  have hlen : (loads.set (argLeastLoad loads) (loads.getD (argLeastLoad loads) 0 + d)).length = loads.length :=
    List.length_set
  have hsum' := sum_assign loads lanes idx d hne
  have hleast : loads.length * loads.getD (argLeastLoad loads) 0 ≤ loads.sum := length_mul_least_le_sum loads hne
  have hd : d ≤ (seen ++ [d]).max?.getD 0 :=
    le_max_of_mem _ (by simp) _ (List.mem_append_right _ (List.mem_singleton_self d))
  have hmax : seen.max?.getD 0 ≤ (seen ++ [d]).max?.getD 0 := max_le_max_append seen _
  have htotal : (seen ++ [d]).sum = seen.sum + d := by simp
  have hmul : (loads.length - 1) * d ≤ (loads.length - 1) * (seen ++ [d]).max?.getD 0 := Nat.mul_le_mul_left _ hd
  have hpos : 0 < loads.length := by
    cases loads with
    | nil => simp at hne
    | cons _ _ => simp
  by_cases hij : argLeastLoad loads = j
  · rw [← hij] at hj ⊢
    rw [getD_set, ite_eq_left rfl, ite_eq_left hm, hlen, Nat.left_distrib]
    have hsplit : loads.length * d = (loads.length - 1) * d + d := mul_succ_sub _ _ hpos
    omega
  · rw [getD_set, ite_eq_right hij, hlen]
    have hj' : j < loads.length := hlen ▸ hj
    have := hinv j hj'
    have hmono : (loads.length - 1) * seen.max?.getD 0 ≤ (loads.length - 1) * (seen ++ [d]).max?.getD 0 :=
      Nat.mul_le_mul_left _ hmax
    omega

/-- The bound holds after any queue: for `S` the releases' sum (`≤ m·R`) and `R` the releases' max,
machine `j` ends within `total + (m-1)·pmax + m·R`. -/
theorem scheduleFrom_bound
    (S R : Nat) (seen : List Nat) (loads : List Nat) (lanes : List (List Nat)) (offset : Nat) (ds : List Nat)
    (hne : loads ≠ [])
    (hS : S ≤ loads.length * R) (hsum : loads.sum = S + seen.sum)
    (hinv : ∀ j, j < loads.length →
      loads.length * loads.getD j 0 ≤ seen.sum + (loads.length - 1) * seen.max?.getD 0 + loads.length * R) :
    ∀ j, j < (scheduleFrom loads lanes offset ds).2.length →
      (scheduleFrom loads lanes offset ds).2.length * (scheduleFrom loads lanes offset ds).2.getD j 0 ≤
        (seen ++ ds).sum + ((scheduleFrom loads lanes offset ds).2.length - 1) * (seen ++ ds).max?.getD 0 + (scheduleFrom loads lanes offset ds).2.length * R := by
  induction ds generalizing loads lanes offset seen with
  | nil =>
    intro j hj
    simp only [scheduleFrom, List.append_nil] at hj ⊢
    exact hinv j hj
  | cons d ds ih =>
    intro j hj
    simp only [scheduleFrom] at hj ⊢
    have hassign := assign_bound S R seen loads lanes offset d hne hS hsum hinv
    -- recurse with the new state and `seen ++ [d]`
    have hne' : (assign loads lanes offset d).1 ≠ [] := by
      intro e
      have hlen : (assign loads lanes offset d).1.length = loads.length := by unfold assign; exact List.length_set
      rw [e, List.length_nil] at hlen
      exact hne (List.eq_nil_of_length_eq_zero hlen.symm)
    have hS' : S ≤ (assign loads lanes offset d).1.length * R := by
      unfold assign; rw [List.length_set]; exact hS
    have hsum' : (assign loads lanes offset d).1.sum = S + (seen ++ [d]).sum := by
      rw [sum_assign loads lanes offset d hne, hsum]; simp; omega
    have hinv' := hassign
    have hih := ih (seen ++ [d]) (assign loads lanes offset d).1 (assign loads lanes offset d).2 (offset + 1) hne' hS' hsum' hinv'
    have := hih j hj
    rwa [List.append_assoc] at this

/-- `getD` into a `map` of `[]`s is `[]`. -/
theorem getD_map_nil (m : Nat) (l : List Nat) : (l.map fun _ => ([] : List Nat)).getD m [] = [] := by
  rw [List.getD_eq_getElem?_getD]
  by_cases hm : m < l.length
  · rw [List.getElem?_eq_getElem (by simpa [List.length_map] using hm)]
    rw [List.getElem_map]; simp
  · rw [List.getElem?_eq_none_iff.mpr (by simpa [List.length_map] using hm)]; simp

/-- Appending a task to one lane adds it to the flattened lanes, up to order. -/
theorem flatten_assign (loads : List Nat) (lanes : List (List Nat)) (idx d : Nat) (hm : argLeastLoad loads < lanes.length) :
    (assign loads lanes idx d).2.flatten ~ lanes.flatten ++ [idx] := by
  unfold assign
  simp only
  rw [List.set_eq_take_append_cons_drop, ite_eq_left hm]
  have hget : lanes.getD (argLeastLoad loads) [] = lanes[argLeastLoad loads]'hm := by
    rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hm]; simp
  rw [hget]
  have hdecomp : lanes = lanes.take (argLeastLoad loads) ++ lanes[argLeastLoad loads]'hm :: lanes.drop (argLeastLoad loads + 1) :=
    take_append_cons_drop lanes _ hm
  conv => lhs; rw [List.flatten_append, List.flatten_cons]
  conv => rhs; rw [hdecomp, List.flatten_append, List.flatten_cons]
  calc (lanes.take (argLeastLoad loads)).flatten ++ ((lanes[argLeastLoad loads]'hm ++ [idx]) ++ (lanes.drop (argLeastLoad loads + 1)).flatten)
      = (lanes.take (argLeastLoad loads)).flatten ++ lanes[argLeastLoad loads]'hm ++ ([idx] ++ (lanes.drop (argLeastLoad loads + 1)).flatten) := by
        simp only [List.append_assoc]
    _ ~ (lanes.take (argLeastLoad loads)).flatten ++ lanes[argLeastLoad loads]'hm ++ ((lanes.drop (argLeastLoad loads + 1)).flatten ++ [idx]) := by
        apply List.Perm.append_left
        apply List.perm_append_comm
    _ ~ ((lanes.take (argLeastLoad loads)).flatten ++ (lanes[argLeastLoad loads]'hm ++ (lanes.drop (argLeastLoad loads + 1)).flatten)) ++ [idx] := by
        simp only [← List.append_assoc]
        exact List.Perm.refl _

/-- The lanes' lengths track the fleet's: `assign` and `scheduleFrom` keep `lanes.length = loads.length`. -/
theorem length_scheduleFrom (loads : List Nat) (lanes : List (List Nat)) (offset : Nat) (ds : List Nat)
    (h : lanes.length = loads.length) :
    (scheduleFrom loads lanes offset ds).1.length = loads.length ∧ (scheduleFrom loads lanes offset ds).2.length = loads.length := by
  induction ds generalizing loads lanes offset with
  | nil => exact ⟨h, rfl⟩
  | cons d ds ih =>
    simp only [scheduleFrom]
    simpa only [assign, List.length_set] using ih (assign loads lanes offset d).1 (assign loads lanes offset d).2 (offset + 1)
      (by unfold assign; rw [List.length_set, List.length_set]; exact h)

/-- The lanes scheduleFrom builds hold exactly the task indices handed out, from `offset`: the
flattened lanes are the old ones plus `range' offset ds.length`, up to order. -/
theorem flatten_scheduleFrom (loads : List Nat) (lanes : List (List Nat)) (offset : Nat) (ds : List Nat)
    (hne : loads ≠ []) (h : lanes.length = loads.length) :
    (scheduleFrom loads lanes offset ds).1.flatten ~ lanes.flatten ++ List.range' offset ds.length := by
  induction ds generalizing loads lanes offset with
  | nil => simp [scheduleFrom]
  | cons d ds ih =>
    simp only [scheduleFrom]
    have hm : argLeastLoad loads < lanes.length := h ▸ argLeastLoad_lt loads hne
    have hlen : (assign loads lanes offset d).2.length = (assign loads lanes offset d).1.length := by
      unfold assign; rw [List.length_set, List.length_set]; exact h
    have hne' : (assign loads lanes offset d).1 ≠ [] := by
      intro e
      have hl : (assign loads lanes offset d).1.length = loads.length := by unfold assign; exact List.length_set
      rw [e, List.length_nil] at hl
      exact hne (List.eq_nil_of_length_eq_zero hl.symm)
    have hih := ih (assign loads lanes offset d).1 (assign loads lanes offset d).2 (offset + 1) hne' hlen
    have hflat := flatten_assign loads lanes offset d hm
    have htrans : (scheduleFrom (assign loads lanes offset d).1 (assign loads lanes offset d).2 (offset + 1) ds).1.flatten ~
        (lanes.flatten ++ [offset]) ++ List.range' (offset + 1) ds.length :=
      hih.trans (List.Perm.append_right _ hflat)
    have hrange : List.range' offset (ds.length + 1) = [offset] ++ List.range' (offset + 1) ds.length := rfl
    rw [show (d :: ds).length = ds.length + 1 from rfl, hrange]
    rw [List.append_assoc] at htrans
    exact htrans

/-- The flatten of `map (fun _ => [])` is empty. -/
theorem flatten_map_nil (l : List Nat) : (l.map fun _ => ([] : List Nat)).flatten = [] := by
  induction l with
  | nil => simp
  | cons a t ih => rw [List.map_cons, List.flatten_cons]; simp only [List.nil_append]; exact ih

/-- **(a)** Every task lands in exactly one lane: the flattened lanes are a permutation of the queue
indices `range durations.length`. -/
theorem lanes_perm (releases : List Nat) (durations : List Nat) (hne : releases ≠ []) :
    (listSchedule releases durations).1.flatten ~ List.range durations.length := by
  have hlen : (releases.map fun _ => []).length = releases.length := List.length_map (f := fun _ => ([] : List Nat))
  have hflat := flatten_scheduleFrom releases (releases.map fun _ => []) 0 durations hne hlen
  have hempty : (releases.map fun _ => ([] : List Nat)).flatten = [] := flatten_map_nil releases
  unfold listSchedule
  simp only
  rw [hempty] at hflat
  simp only [List.nil_append] at hflat
  exact hflat.trans (by rw [List.range_eq_range'])

/-- **(b)** Graham's bound with releases: `m·C_max ≤ total + (m-1)·p_max + m·maxRelease`. -/
theorem makespan_bound (releases durations : List Nat) (hne : releases ≠ []) :
    releases.length * (listSchedule releases durations).2.2 ≤
      durations.sum + (releases.length - 1) * durations.max?.getD 0 + releases.length * releases.max?.getD 0 := by
  unfold listSchedule
  simp only
  have hR : releases.sum ≤ releases.length * releases.max?.getD 0 :=
    sum_le_length_mul_of_le releases _ fun x hx => le_max_of_mem releases hne x hx
  have hinv : ∀ j, j < releases.length →
      releases.length * releases.getD j 0 ≤ ([].sum) + (releases.length - 1) * [].max?.getD 0 + releases.length * releases.max?.getD 0 := by
    intro j hj
    simp only [List.sum_nil, List.max?_nil, Option.getD_none, Nat.mul_zero, Nat.add_zero]
    have hle : releases.getD j 0 ≤ releases.max?.getD 0 := by
      rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hj]
      exact le_max_of_mem releases hne _ (List.getElem_mem hj)
    have := Nat.mul_le_mul_left releases.length hle
    omega
  have hbound := scheduleFrom_bound releases.sum (Option.getD releases.max? 0) [] releases (releases.map fun _ => []) 0 durations hne hR (by simp) hinv
  have hlen : (scheduleFrom releases (releases.map fun _ => []) 0 durations).2.length = releases.length :=
    (length_scheduleFrom _ _ _ _ (List.length_map (f := fun _ => ([] : List Nat)))).2
  have hne' : (scheduleFrom releases (releases.map fun _ => []) 0 durations).2 ≠ [] := by
    intro e; rw [e, List.length_nil] at hlen
    exact hne (List.eq_nil_of_length_eq_zero hlen.symm)
  obtain ⟨i, hi, hget⟩ := max_mem _ hne'
  have hgetD : (scheduleFrom releases (releases.map fun _ => []) 0 durations).2.getD i 0 =
      (scheduleFrom releases (releases.map fun _ => []) 0 durations).2[i]'hi := by
    rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hi]; simp
  have hb := hbound i hi
  rw [hlen, hgetD, hget] at hb
  exact hb

/-- A fleet of all-zero releases has `maxRelease = 0`. -/
theorem max_replicate_zero (m : Nat) (hm : 0 < m) : (List.replicate m 0).max?.getD 0 = 0 := by
  have hne : List.replicate m 0 ≠ [] := by
    intro e
    have hlen := List.length_replicate (n := m) (a := 0)
    rw [e, List.length_nil] at hlen
    omega
  obtain ⟨i, hi, hget⟩ := max_mem _ hne
  rw [← hget]
  exact List.getElem_replicate hi

/-- **Graham's bound**, all releases zero: `m·C_max ≤ total + (m-1)·p_max`. -/
theorem graham_bound (m : Nat) (durations : List Nat) (hm : 0 < m) :
    m * (listSchedule (List.replicate m 0) durations).2.2 ≤ durations.sum + (m - 1) * durations.max?.getD 0 := by
  have hb := makespan_bound (List.replicate m 0) durations (by
    intro e
    have hlen := List.length_replicate (n := m) (a := 0)
    rw [e, List.length_nil] at hlen
    omega)
  rw [List.length_replicate, max_replicate_zero m hm] at hb
  simpa using hb

/-- **Corollary**: against any bound `L` on the optimum (`m·L ≥ total`, `L ≥ p_max`),
`m·C_max ≤ (2m-1)·L`. -/
theorem graham_vs_optimal (m L : Nat) (durations : List Nat) (hm : 0 < m)
    (hL : durations.sum ≤ m * L) (hP : durations.max?.getD 0 ≤ L) :
    m * (listSchedule (List.replicate m 0) durations).2.2 ≤ (2 * m - 1) * L := by
  have hb := graham_bound m durations hm
  have hmul : (m - 1) * durations.max?.getD 0 ≤ (m - 1) * L := Nat.mul_le_mul_left _ hP
  rw [show 2 * m - 1 = m + (m - 1) from by omega, Nat.add_mul]
  omega

/-- `map (getD durations · 0) (range durations.length) = durations`. -/
theorem map_range_getD (durations : List Nat) :
    (List.range durations.length).map (fun i => durations.getD i 0) = durations := by
  apply List.ext_getElem
  · simp
  · intro i h₁ h₂
    rw [List.getElem_map, List.getElem_range]
    rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem (by simpa using h₂)]; simp

/-- Every element of a nonnegative list is at most its sum. -/
theorem le_sum_of_mem (l : List Nat) (x : Nat) (hx : x ∈ l) : x ≤ l.sum := by
  induction l with
  | nil => simp at hx
  | cons a t ih =>
    rw [List.sum_cons]
    cases List.mem_cons.mp hx with
    | inl h => omega
    | inr h => have := ih h; omega

/-- `flatten` commutes with `map (map f)`. -/
theorem flatten_map_map (f : Nat → Nat) (ls : List (List Nat)) :
    ((ls.map (·.map f)).flatten) = ls.flatten.map f := by
  induction ls with
  | nil => simp
  | cons a t ih => rw [List.map_cons, List.flatten_cons, ih, List.flatten_cons, List.map_append]

/-- **(c)** Lower-bound soundness: for ANY partition `lanes` of the tasks over `m` machines, the
machine loads summing to `total` force `m·peak ≥ total` and `peak ≥ p_max`. -/
theorem lower_bound (durations : List Nat) (lanes : List (List Nat))
    (hperm : lanes.flatten ~ List.range durations.length) :
    lanes.length * (lanes.map (fun lane => (lane.map fun i => durations.getD i 0).sum)).max?.getD 0 ≥ durations.sum ∧
      (durations ≠ [] →
        (lanes.map (fun lane => (lane.map fun i => durations.getD i 0).sum)).max?.getD 0 ≥ durations.max?.getD 0) := by
  let loadSum : List Nat → Nat := fun lane => (lane.map fun i => durations.getD i 0).sum
  have htot : (lanes.map loadSum).sum = durations.sum := by
    have key : (lanes.map loadSum).sum = (lanes.flatten.map fun i => durations.getD i 0).sum := by
      clear hperm
      induction lanes with
      | nil => simp
      | cons a t ih =>
        rw [List.map_cons, List.sum_cons, ih, List.flatten_cons, List.map_append, List.sum_append]
    rw [key]
    have hmap : lanes.flatten.map (fun i => durations.getD i 0) ~ (List.range durations.length).map (fun i => durations.getD i 0) :=
      List.Perm.map _ hperm
    rw [map_range_getD] at hmap
    exact hmap.sum_nat
  constructor
  · by_cases hnl : lanes = []
    · subst hnl; simp_all
    · have hne' : lanes.map loadSum ≠ [] := by
        intro e; exact hnl (by cases lanes with | nil => rfl | cons x xs => simp at e)
      have hub : ∀ x ∈ lanes.map loadSum, x ≤ (lanes.map loadSum).max?.getD 0 := fun x hx => le_max_of_mem _ hne' x hx
      have hsum := sum_le_length_mul_of_le (lanes.map loadSum) _ hub
      rwa [htot, List.length_map] at hsum
  · intro hd
    obtain ⟨i, hi, hget⟩ := max_mem durations hd
    have hin : i ∈ lanes.flatten := hperm.mem_iff.mpr (List.mem_range.mpr hi)
    obtain ⟨lane, hlane, hi'⟩ := List.mem_flatten.mp hin
    have hload : durations.getD i 0 ≤ loadSum lane :=
      le_sum_of_mem _ _ (List.mem_map.mpr ⟨i, hi', rfl⟩)
    have hpeak : loadSum lane ≤ (lanes.map loadSum).max?.getD 0 :=
      le_max_of_mem _ (by cases lanes with | nil => simp at hlane | cons _ _ => simp) _ (List.mem_map.mpr ⟨lane, hlane, rfl⟩)
    have hle : durations[i] ≤ durations.max?.getD 0 := le_max_of_mem durations hd _ (List.getElem_mem hi)
    have hget' : durations.getD i 0 = durations[i] := by
      rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hi]; simp
    have hmax : durations.max?.getD 0 = durations.getD i 0 := hget.symm.trans hget'.symm
    exact hmax ▸ Nat.le_trans hload hpeak

end proofs
end Sched
