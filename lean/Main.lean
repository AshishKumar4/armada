import Lean.Data.Json
import Sched

open Lean Json

/- `lake exe sched` reads one JSON instance on stdin — `{"durations": [d…], "releases": [r…]}` — and
prints what `listSchedule` computes: `{"lanes": [[task…]…], "loads": [l…], "makespan": n}`. -/

def natsOf (key : String) (j : Json) : Except String (List Nat) := do
  let arr ← j.getObjVal? key >>= getArr?
  arr.toList.mapM fun x => match x.getNat? with
    | .ok n => .ok n
    | .error e => .error e

def jsonOf (lanes : List (List Nat)) (loads : List Nat) (makespan : Nat) : Json :=
  Json.mkObj [
    ("lanes", Json.arr (lanes.toArray.map fun lane => Json.arr (lane.toArray.map (fun n => Json.num (JsonNumber.fromNat n))))),
    ("loads", Json.arr (loads.toArray.map fun n => Json.num (JsonNumber.fromNat n))),
    ("makespan", Json.num (JsonNumber.fromNat makespan)),
  ]

def main : IO UInt32 := do
  let input ← IO.FS.Stream.readToEnd (← IO.getStdin)
  match Json.parse input with
  | .error e => IO.eprintln s!"json: {e}"; return 1
  | .ok j =>
    match natsOf "durations" j, natsOf "releases" j with
    | .ok durations, .ok releases =>
      let (lanes, loads, makespan) := Sched.listSchedule releases durations
      IO.println (jsonOf lanes loads makespan).compress
      return 0
    | .error e, _ | _, .error e => IO.eprintln s!"fields: {e}"; return 1
