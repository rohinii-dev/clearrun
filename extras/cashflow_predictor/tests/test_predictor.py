import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import predictor as P


class TestMath(unittest.TestCase):
    def test_msmed_interest_hand_check(self):
        # monthly rate = 3 * 6.5% / 12 = 1.625%; one month on Rs 1,00,000 = Rs 1,625
        self.assertAlmostEqual(P.msmed_interest(100000, 30, 0.065, 3), 1625.0, places=4)
        self.assertEqual(P.msmed_interest(100000, 0, 0.065, 3), 0.0)
        # two months compounds: 100000 * (1.01625^2 - 1)
        self.assertAlmostEqual(P.msmed_interest(100000, 60, 0.065, 3), 100000 * (1.01625 ** 2 - 1), places=4)

    def test_promise_reliability(self):
        self.assertAlmostEqual(P.promise_reliability(6, 2), 0.7)
        self.assertAlmostEqual(P.promise_reliability(0, 0), 0.5)     # no history -> 50/50

    def test_no_history_customer_uses_portfolio_average(self):
        m = P.Model(runs=200)
        new = [c for c in m.customers if "new" in c["name"]][0]
        gm = sum(b["mu"] for b in m.behave.values()) / len(m.behave)
        self.assertEqual(m.behave[new["id"]]["n_eff"], 0.0)
        self.assertGreater(m.behave[new["id"]]["sigma"], 5)           # wide uncertainty
        self.assertLess(abs(m.behave[new["id"]]["mu"] - gm), 10)


class TestModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = P.Model(runs=400)
        cls.base = cls.m.run()

    def test_reproducible(self):
        again = P.Model(runs=400).run()
        self.assertEqual(self.base["prob_below_buffer"], again["prob_below_buffer"])

    def test_probabilities_are_valid(self):
        b = self.base
        self.assertTrue(0 <= b["prob_negative"] <= b["prob_below_buffer"] <= 1)

    def test_percentile_order(self):
        b = self.base
        self.assertTrue((b["p10"] <= b["p50"] + 1e-6).all() and (b["p50"] <= b["p90"] + 1e-6).all())

    def test_later_payments_never_help(self):
        late = self.m.run({"delay_shift_days": {"ALL": 10}})
        self.assertGreaterEqual(late["prob_below_buffer"], self.base["prob_below_buffer"])

    def test_extra_expense_never_helps(self):
        r = self.m.run({"one_time_expenses": [{"day": 15, "amount": 100000}]})
        self.assertGreaterEqual(r["prob_below_buffer"], self.base["prob_below_buffer"])

    def test_collecting_early_never_hurts(self):
        inv = self.m.open_inv[0]["no"]
        r = self.m.run({"force_paid": {inv: 1}})
        self.assertLessEqual(r["prob_below_buffer"], self.base["prob_below_buffer"])

    def test_msme_extension_has_cost_non_msme_does_not(self):
        self.assertGreater(self.m.run({"supplier_extension_days": {"Fabric Mills": 30}})["extra_msmed_interest"], 0)
        self.assertEqual(self.m.run({"supplier_extension_days": {"Electricity": 30}})["extra_msmed_interest"], 0)


if __name__ == "__main__":
    unittest.main()
