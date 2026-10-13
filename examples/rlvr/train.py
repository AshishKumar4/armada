"""GRPO with TRL on one GPU, its rewards graded on armada: `python3 train.py`. Qwen2.5-0.5B-Instruct learns MBPP's
problems for a few steps; a real run trains longer, on more GPUs.

Needs `pip install trl datasets`, a CUDA GPU and the armada SDK. TRL calls the reward once a step, with the step's
completions and each one's row of the dataset; `unit_tests.stream` grades them all as one job."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from datasets import load_dataset
from tasks.reward import Sample, unit_tests
from trl import GRPOConfig, GRPOTrainer

from armada import Result


def program(completion: str | list[dict[str, str]]) -> str:
    """The completion's last fenced code block, or all of it. A chat model's completion is its messages."""
    text = completion if isinstance(completion, str) else completion[-1]["content"]
    blocks = re.findall(r"```(?:python)?\n(.*?)```", text, re.DOTALL)
    return blocks[-1] if blocks else text


def unit_test_reward(completions: list[str], test_list: list[list[str]], test_imports: list[list[str]], **_: object) -> list[float | None]:
    """Each completion's share of its problem's tests passed. A grader that errs or times out may have been killed by its
    program, which scores 0; one the platform lost or cancelled gets no reward (None)."""
    samples = [{"program": "\n".join([*imports, program(completion)]), "tests": tests}
               for completion, tests, imports in zip(completions, test_list, test_imports, strict=True)]
    return [reward(result) for result in unit_tests.stream(samples).settled()]


def reward(result: Result[Sample, float]) -> float | None:
    if result.ok:
        return result.value
    return None if result.kind in ("lost", "cancelled") else 0.0


def prompt(row: dict[str, object]) -> dict[str, object]:
    tests = "\n".join(row["test_list"])
    asked = f"{row['prompt']}\nYour code should pass these tests:\n{tests}\nAnswer with one Python code block."
    return {"prompt": [{"role": "user", "content": asked}]}


dataset = load_dataset("google-research-datasets/mbpp", "sanitized", split="test").map(prompt)

trainer = GRPOTrainer(
    model="Qwen/Qwen2.5-0.5B-Instruct",
    reward_funcs=unit_test_reward,
    train_dataset=dataset,
    args=GRPOConfig(output_dir="grpo", max_steps=4, per_device_train_batch_size=16, num_generations=8, max_completion_length=384,
                    bf16=True, report_to="none", logging_steps=1, save_strategy="no"),
)
trainer.train()
