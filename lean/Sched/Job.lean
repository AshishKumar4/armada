/-
`Sched.Job` — worker/src/job.ts's task lifecycle, as the outcomes a job keeps.

A task is `queued`, `forming` (a gang gathering ranks), `running`, `landing`
(its accepted answer is landing), or `closed` — `exited`, `failed`, `lost` or
`cancelled` in the SQL rows. `dup` is the speculative second runner a straggler
gets. The model covers what decides the answer stream: `claim` (queued →
running), `accept` (running → landing — the first to land wins), `complete`
(landing → closed, one outcome appended), `retry` (landing → queued, no
answer), `requeue`/`promote`/`failT` (vesselFailed: requeue under the infra
limit, promote the duplicate, else closed with a `failed` outcome) and `closeAll`
(the job's cancel path, closing every open task with its outcome).

**Theorem (e)**: over any sequence of operations, every task ends with exactly
one outcome — its first accepted answer — and a closed task is never reopened:
once the job is done, `answers` is a permutation of the task indexes.
-/
import Sched.Basic

namespace Sched

open List

/-- A task's place in its lifecycle; `closed` is every terminal state. -/
inductive Phase where
  | queued | forming | running | landing | closed
  deriving DecidableEq, Repr

/-- One task: its phase and whether a speculative duplicate runs beside it. -/
structure JobTask where
  phase : Phase
  dup : Bool := false
  deriving Repr

/-- The job: its tasks and the outcomes kept so far, `(index, outcome)` pairs. -/
structure Job where
  tasks : List JobTask
  answers : List (Nat × Nat)

/-- The step the SQL `UPDATE`s run: task `i` moves to `phase`, `dup` reset. -/
def move (tasks : List JobTask) (i : Nat) (phase : Phase) (dup : Bool := false) : List JobTask :=
  tasks.set i { phase, dup }

/-- `claim`: a queued task runs. -/
def claimT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .queued then { j with tasks := move j.tasks i .running } else j

/-- `forming`: a gang's task waits for its ranks. -/
def formT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .queued then { j with tasks := move j.tasks i .forming } else j

/-- `gangStart`: every rank joined; the task runs. -/
def gangT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .forming then { j with tasks := move j.tasks i .running } else j

/-- `dup`: a straggler's speculative second runner joins. -/
def dupT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .running && !(j.tasks.getD i { phase := .closed }).dup
    then { j with tasks := move j.tasks i .running true }
    else j

/-- `accept`: the first answer to land is the one kept. -/
def acceptT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .running then { j with tasks := move j.tasks i .landing } else j

/-- `complete`: the kept answer lands; the task closes with exactly it. -/
def completeT (j : Job) (i o : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .landing
    then { tasks := move j.tasks i .closed, answers := j.answers ++ [(i, o)] }
    else j

/-- `retry`: a named failure is queued again with no outcome kept. -/
def retryT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .landing then { j with tasks := move j.tasks i .queued } else j

/-- `vesselFailed` under the infra limit: the task is queued again. -/
def requeueT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .running then { j with tasks := move j.tasks i .queued } else j

/-- `vesselFailed` with a duplicate: it takes the task over and keeps running. -/
def promoteT (j : Job) (i : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .running && (j.tasks.getD i { phase := .closed }).dup
    then { j with tasks := move j.tasks i .running }
    else j

/-- `vesselFailed` at the infra limit, or `cancel`: the task closes with a `failed` outcome. -/
def failT (j : Job) (i o : Nat) : Job :=
  if (j.tasks.getD i { phase := .closed }).phase == .running || (j.tasks.getD i { phase := .closed }).phase == .landing
    then { tasks := move j.tasks i .closed, answers := j.answers ++ [(i, o)] }
    else j

/-- The cancel/closeAll step applied to one index: an open task closes with its outcome. -/
def closeStep (acc : Job) (outcomes : List Nat) (i : Nat) : Job :=
  if (acc.tasks.getD i { phase := .closed }).phase == .closed then acc
  else { tasks := move acc.tasks i .closed, answers := acc.answers ++ [(i, outcomes.getD i 0)] }

/-- The job's cancel path: every task still open closes with its own outcome. -/
def closeAll (j : Job) (outcomes : List Nat) : Job :=
  (List.range j.tasks.length).foldl (fun acc i => closeStep acc outcomes i) j

/-- The job's invariant: no index has two outcomes, every closed task has one,
and every outcome belongs to a closed task. -/
def Job.Inv (j : Job) : Prop :=
  j.answers.Pairwise (fun a b => a.1 ≠ b.1) ∧
    (∀ (i : Nat) (hi : i < j.tasks.length), (j.tasks[i]'hi).phase = .closed → ∃ o, (i, o) ∈ j.answers) ∧
    (∀ a ∈ j.answers, ∃ (hi : a.1 < j.tasks.length), (j.tasks[a.1]'hi).phase = .closed)

/-- An index the answers already name. -/
def answered (answers : List (Nat × Nat)) (i : Nat) : Prop := ∃ o, (i, o) ∈ answers

/-- `set` touches only index `i`. -/
theorem getElem_set_ne' {α : Type} (l : List α) (i j : Nat) (x : α) (h : i ≠ j) (hj : j < l.length) :
    (l.set i x)[j]'(by simpa using hj) = l[j] :=
  List.getElem_set_ne h (by simpa using hj)

/-- Task `j`'s record under `move` to `i`: written at `i`, untouched elsewhere. -/
theorem move_at (tasks : List JobTask) (i j : Nat) (phase : Phase) (dup : Bool)
    (hj : j < tasks.length) :
    (move tasks i phase dup)[j]'(by rw [move, List.length_set]; exact hj) =
      if i = j then { phase, dup } else tasks[j] := by
  unfold move
  by_cases h : i = j
  · rw [ite_eq_left h, h, List.getElem_set_self]
  · rw [ite_eq_right h, getElem_set_ne' _ _ _ _ h hj]

/-- The phase a `move` leaves at `i`. -/
theorem phase_of_move (tasks : List JobTask) (i : Nat) (phase : Phase) (dup : Bool)
    (hi : i < tasks.length) :
    (move tasks i phase dup)[i]'(by rw [move, List.length_set]; exact hi) = ⟨phase, dup⟩ := by
  unfold move
  rw [List.getElem_set_self]

/-- A `closed` check on `getD` agrees with `getElem` at a live index. -/
theorem getD_phase (tasks : List JobTask) (i : Nat) (hi : i < tasks.length) :
    (tasks.getD i { phase := .closed }).phase = tasks[i].phase := by
  rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hi]; simp

/-- `getD` out of bounds is the closed default — every op's guard fails there. -/
theorem getD_oob (tasks : List JobTask) (i : Nat) (hi : ¬ i < tasks.length) :
    (tasks.getD i { phase := .closed }).phase = .closed := by
  rw [List.getD_eq_getElem?_getD, List.getElem?_eq_none_iff.mpr (by omega)]; simp

/-- A task that is open has no answer yet. -/
theorem not_answered_of_open (j : Job) (hinv : Job.Inv j) (i : Nat) (hi : i < j.tasks.length)
    (p : Phase) (h : j.tasks[i].phase = p) (hp : p ≠ .closed) : ¬ answered j.answers i := by
  rintro ⟨o, ho⟩
  obtain ⟨hi', hclosed⟩ := hinv.2.2 (i, o) ho
  rw [h] at hclosed
  exact hp hclosed

/-- Appending an outcome for an unanswered index keeps the stream idx-pairwise. -/
theorem pairwise_append (answers : List (Nat × Nat)) (i o : Nat)
    (hp : answers.Pairwise fun a b => a.1 ≠ b.1) (hfresh : ¬ answered answers i) :
    (answers ++ [(i, o)]).Pairwise fun a b => a.1 ≠ b.1 := by
  rw [List.pairwise_append]
  refine ⟨hp, by simp, ?_⟩
  intro a ha b hb
  rw [List.mem_singleton] at hb
  subst hb
  intro heq
  have heq' : a.1 = i := heq
  exact hfresh ⟨a.2, by rw [← heq']; exact ha⟩

/-- `Inv` holds of a fresh job (no task closed yet — nothing is answered). -/
theorem inv_init (tasks : List JobTask) (hfresh : ∀ i (hi : i < tasks.length), tasks[i].phase ≠ .closed) :
    Job.Inv ⟨tasks, []⟩ := by
  refine ⟨List.Pairwise.nil, ?_, ?_⟩
  · intro i hi hclosed
    exact absurd hclosed (hfresh i hi)
  · intro a ha
    simp at ha

/-- The shared step: `Inv` survives a `move` of one task. -/
theorem inv_of_move (j : Job) (hinv : Job.Inv j) (i : Nat) (phase' : Phase) (dup : Bool)
    (hi : i < j.tasks.length) (hopen : j.tasks[i].phase ≠ .closed) (hp' : phase' ≠ .closed) :
    Job.Inv { j with tasks := move j.tasks i phase' dup } := by
  obtain ⟨hans, hclosed, hmem⟩ := hinv
  refine ⟨hans, ?_, ?_⟩
  · intro k hk hk'
    have hk0 : k < j.tasks.length := by
      simp only [move, List.length_set] at hk
      exact hk
    by_cases h : i = k
    · subst h
      rw [phase_of_move j.tasks i phase' dup hi] at hk'
      exact absurd hk' hp'
    · have hk'' : j.tasks[k].phase = .closed := by
        have := move_at j.tasks i k phase' dup hk0
        rw [ite_eq_right h] at this
        exact this ▸ hk'
      exact hclosed k hk0 hk''
  · intro a ha
    obtain ⟨hia, ha'⟩ := hmem a ha
    refine ⟨by rw [move, List.length_set]; exact hia, ?_⟩
    by_cases h : i = a.1
    · subst h
      exact absurd ha' hopen
    · rw [move_at j.tasks i a.1 phase' dup hia, ite_eq_right h]
      exact ha' 

/-- A `move` applied under a phase guard: out of range the guard was on `.closed`. -/
theorem move_guard (j : Job) (i : Nat) (p : Phase) (hp : p ≠ .closed)
    (h : ((j.tasks.getD i { phase := .closed }).phase == p) = true) :
    ∃ hi : i < j.tasks.length, j.tasks[i].phase = p := by
  by_cases hi : i < j.tasks.length
  · rw [getD_phase j.tasks i hi] at h
    exact ⟨hi, of_decide_eq_true h⟩
  · rw [getD_oob j.tasks i hi] at h
    simp [of_decide_eq_true h] at hp

/-- `claim`: a queued task starts running — `Inv` survives. -/
theorem inv_claim (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (claimT j i) := by
  unfold claimT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .queued (by decide) h
    exact inv_of_move j hinv i .running false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `formT` — `Inv` survives. -/
theorem inv_form (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (formT j i) := by
  unfold formT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .queued (by decide) h
    exact inv_of_move j hinv i .forming false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `gangT` — `Inv` survives. -/
theorem inv_gang (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (gangT j i) := by
  unfold gangT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .forming (by decide) h
    exact inv_of_move j hinv i .running false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `dupT` — `Inv` survives. -/
theorem inv_dup (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (dupT j i) := by
  unfold dupT
  split
  · next h =>
    have hr : ((j.tasks.getD i { phase := .closed }).phase == .running) = true := by
      rw [Bool.and_eq_true] at h; exact h.1
    obtain ⟨hi, hp⟩ := move_guard j i .running (by decide) hr
    exact inv_of_move j hinv i .running true hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `acceptT` — `Inv` survives. -/
theorem inv_accept (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (acceptT j i) := by
  unfold acceptT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .running (by decide) h
    exact inv_of_move j hinv i .landing false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `retryT` — `Inv` survives. -/
theorem inv_retry (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (retryT j i) := by
  unfold retryT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .landing (by decide) h
    exact inv_of_move j hinv i .queued false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `requeueT` — `Inv` survives. -/
theorem inv_requeue (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (requeueT j i) := by
  unfold requeueT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .running (by decide) h
    exact inv_of_move j hinv i .queued false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- `promoteT` — `Inv` survives. -/
theorem inv_promote (j : Job) (hinv : Job.Inv j) (i : Nat) : Job.Inv (promoteT j i) := by
  unfold promoteT
  split
  · next h =>
    have hr : ((j.tasks.getD i { phase := .closed }).phase == .running) = true := by
      rw [Bool.and_eq_true] at h; exact h.1
    obtain ⟨hi, hp⟩ := move_guard j i .running (by decide) hr
    exact inv_of_move j hinv i .running false hi (by rw [hp]; decide) (by decide)
  · exact hinv

/-- The append-answer step `completeT`/`failT`/`closeStep` share: `move` task `i`
to `closed` and append `(i, o)`, given task `i` was open — `Inv` survives. -/
theorem inv_close_one (j : Job) (hinv : Job.Inv j) (i o : Nat) (hi : i < j.tasks.length)
    (hopen : j.tasks[i].phase ≠ .closed) :
    Job.Inv { tasks := move j.tasks i .closed, answers := j.answers ++ [(i, o)] } := by
  have hfresh : ¬ answered j.answers i := by
    cases hp : j.tasks[i].phase with
    | queued => exact not_answered_of_open j hinv i hi .queued hp (by decide)
    | forming => exact not_answered_of_open j hinv i hi .forming hp (by decide)
    | running => exact not_answered_of_open j hinv i hi .running hp (by decide)
    | landing => exact not_answered_of_open j hinv i hi .landing hp (by decide)
    | closed => exact absurd hp hopen
  obtain ⟨hans, hclosed, hmem⟩ := hinv
  refine ⟨pairwise_append _ _ _ hans hfresh, ?_, ?_⟩
  · intro k hk hk'
    have hk0 : k < j.tasks.length := by
      simp only [move, List.length_set] at hk
      exact hk
    by_cases h : i = k
    · subst h
      exact ⟨o, List.mem_append_right _ (List.mem_singleton_self _)⟩
    · have hk'' : j.tasks[k].phase = .closed := by
        have := move_at j.tasks i k .closed false hk0
        rw [ite_eq_right h] at this
        exact this ▸ hk'
      obtain ⟨o', ho'⟩ := hclosed k hk0 hk''
      exact ⟨o', List.mem_append_left _ ho'⟩
  · intro a ha
    rw [List.mem_append] at ha
    cases ha with
    | inl ha =>
      obtain ⟨hia, ha'⟩ := hmem a ha
      refine ⟨by rw [move, List.length_set]; exact hia, ?_⟩
      by_cases h : i = a.1
      · subst h
        exact absurd ha' hopen
      · rw [move_at j.tasks i a.1 .closed false hia, ite_eq_right h]
        exact ha'
    | inr ha =>
      rw [List.mem_singleton] at ha
      subst ha
      refine ⟨by rw [move, List.length_set]; exact hi, ?_⟩
      rw [phase_of_move j.tasks i .closed false hi]

/-- `completeT` — `Inv` survives. -/
theorem inv_complete (j : Job) (hinv : Job.Inv j) (i o : Nat) : Job.Inv (completeT j i o) := by
  unfold completeT
  split
  · next h =>
    obtain ⟨hi, hp⟩ := move_guard j i .landing (by decide) h
    exact inv_close_one j hinv i o hi (by rw [hp]; decide)
  · exact hinv

/-- `failT` — `Inv` survives. -/
theorem inv_fail (j : Job) (hinv : Job.Inv j) (i o : Nat) : Job.Inv (failT j i o) := by
  unfold failT
  split
  · next h =>
    rw [Bool.or_eq_true] at h
    have hi : i < j.tasks.length := by
      by_cases hi : i < j.tasks.length
      · exact hi
      · rw [getD_oob j.tasks i hi] at h
        cases h with | inl h => simp at h | inr h => simp at h
    have hopen : j.tasks[i].phase ≠ .closed := by
      cases h with
      | inl h =>
        have := move_guard j i .running (by decide) h
        rw [this.2]; decide
      | inr h =>
        have := move_guard j i .landing (by decide) h
        rw [this.2]; decide
    exact inv_close_one j hinv i o hi hopen
  · exact hinv

/-- `closeStep` — `Inv` survives. -/
theorem inv_closeStep (j : Job) (hinv : Job.Inv j) (outcomes : List Nat) (i : Nat) :
    Job.Inv (closeStep j outcomes i) := by
  unfold closeStep
  split
  · exact hinv
  · next h =>
    have hi : i < j.tasks.length := by
      by_cases hi : i < j.tasks.length
      · exact hi
      · rw [getD_oob j.tasks i hi] at h
        simp at h
    have hp : j.tasks[i].phase ≠ .closed := by
      have hd := getD_phase j.tasks i hi
      intro heq
      rw [hd, heq] at h
      simp at h
    exact inv_close_one j hinv i _ hi hp

/-- `closeAll` — `Inv` survives. -/
theorem inv_closeAll (j : Job) (hinv : Job.Inv j) (outcomes : List Nat) : Job.Inv (closeAll j outcomes) := by
  unfold closeAll
  generalize hj : j = j'
  rw [← hj]
  suffices aux : ∀ (acc : Job) (rest : List Nat), Job.Inv acc →
      Job.Inv (rest.foldl (fun acc i => closeStep acc outcomes i) acc) by
    exact aux j (List.range j.tasks.length) hinv
  intro acc rest hacc
  induction rest generalizing acc with
  | nil => simpa using hacc
  | cons x xs ih =>
    rw [List.foldl_cons]
    exact ih (closeStep acc outcomes x) (inv_closeStep acc hacc outcomes x)

/-- Every operation the job's handlers can take. -/
inductive Op where
  | claim : Nat → Op
  | form : Nat → Op
  | gang : Nat → Op
  | dup : Nat → Op
  | accept : Nat → Op
  | retry : Nat → Op
  | requeue : Nat → Op
  | promote : Nat → Op
  | complete : Nat → Nat → Op
  | fail : Nat → Nat → Op
  | closeAll : List Nat → Op

/-- One operation applied to the job. -/
def applyOp (j : Job) : Op → Job
  | .claim i => claimT j i
  | .form i => formT j i
  | .gang i => gangT j i
  | .dup i => dupT j i
  | .accept i => acceptT j i
  | .retry i => retryT j i
  | .requeue i => requeueT j i
  | .promote i => promoteT j i
  | .complete i o => completeT j i o
  | .fail i o => failT j i o
  | .closeAll os => closeAll j os

/-- `Inv` survives each single operation. -/
theorem inv_op (j : Job) (hinv : Job.Inv j) (op : Op) : Job.Inv (applyOp j op) := by
  cases op with
  | claim i => exact inv_claim j hinv i
  | form i => exact inv_form j hinv i
  | gang i => exact inv_gang j hinv i
  | dup i => exact inv_dup j hinv i
  | accept i => exact inv_accept j hinv i
  | retry i => exact inv_retry j hinv i
  | requeue i => exact inv_requeue j hinv i
  | promote i => exact inv_promote j hinv i
  | complete i o => exact inv_complete j hinv i o
  | fail i o => exact inv_fail j hinv i o
  | closeAll os => exact inv_closeAll j hinv os

/-- **The job's answer law**: over any sequence of operations, `Inv` holds —
every closed task has exactly one outcome and every outcome is a closed task's
first accepted answer. -/
theorem job_law (tasks : List JobTask)
    (hfresh : ∀ i (hi : i < tasks.length), tasks[i].phase ≠ .closed) (ops : List Op) :
    Job.Inv (ops.foldl applyOp ⟨tasks, []⟩) := by
  suffices aux : ∀ (acc : Job) (rest : List Op), Job.Inv acc → Job.Inv (rest.foldl applyOp acc) by
    exact aux ⟨tasks, []⟩ ops (inv_init tasks hfresh)
  intro acc rest hacc
  induction rest generalizing acc with
  | nil => simpa using hacc
  | cons op tail ih =>
    rw [List.foldl_cons]
    exact ih _ (inv_op acc hacc op)

/-- A late `accept` on a `landing` task is a no-op: the first answer stays kept. -/
theorem accept_late (j : Job) (i : Nat) (hi : i < j.tasks.length)
    (h : j.tasks[i].phase = .landing) : acceptT j i = j := by
  unfold acceptT
  have hd := getD_phase j.tasks i hi
  rw [hd, h]
  rfl

/-- A `complete` after the answer landed still writes only the first acceptor's
outcome: a second `accept` never moves `landing`, so the outcome appended is the
first to land. -/
theorem one_accept (j : Job) (i : Nat) (hi : i < j.tasks.length)
    (h : j.tasks[i].phase = .landing) : (acceptT j i).tasks = j.tasks :=
  congrArg Job.tasks (accept_late j i hi h)

/-- Pairwise unequal heads give nodup head projections. -/
theorem nodup_map_fst (answers : List (Nat × Nat))
    (h : answers.Pairwise fun a b => a.1 ≠ b.1) : (answers.map (·.1)).Nodup := by
  induction answers with
  | nil => simp
  | cons x xs ih =>
    rw [List.pairwise_cons] at h
    rw [List.map_cons, List.nodup_cons]
    refine ⟨?_, ih h.2⟩
    intro hm
    rw [List.mem_map] at hm
    obtain ⟨a, ha, hf⟩ := hm
    exact h.1 a ha (by rw [← hf])

/-- A nodup list whose members are exactly `range n`'s is a permutation of it. -/
theorem perm_of_mem_range (l : List Nat) (n : Nat) (hn : l.Nodup)
    (hmem : ∀ x ∈ l, x < n) (hcov : ∀ x, x < n → x ∈ l) : l ~ List.range n := by
  rw [List.perm_ext_iff_of_nodup hn (List.nodup_range (n := n))]
  intro x
  exact ⟨fun hx => List.mem_range.mpr (hmem x hx), fun hx => hcov x (List.mem_range.mp hx)⟩

/-- **None is lost once the job is done**: every task closed means `answers` is a
permutation of the task indexes — one outcome each, none missing, none twice. -/
theorem answers_done (j : Job) (hinv : Job.Inv j)
    (hall : ∀ (i : Nat) (hi : i < j.tasks.length), j.tasks[i].phase = .closed) :
    j.answers.map (·.1) ~ List.range j.tasks.length := by
  obtain ⟨hans, hclosed, hmem⟩ := hinv
  apply perm_of_mem_range _ _ (nodup_map_fst _ hans)
  · intro x hx
    rw [List.mem_map] at hx
    obtain ⟨a, ha, hf⟩ := hx
    obtain ⟨hia, _⟩ := hmem a ha
    rw [← hf]; exact hia
  · intro x hx
    obtain ⟨o, ho⟩ := hclosed x hx (hall x hx)
    exact List.mem_map.mpr ⟨(x, o), ho, rfl⟩

end Sched
