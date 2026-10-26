import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import customer_risk as cr

T = date(2026, 10, 24)


def cust(delays, kept=0, broken=0, open_overdue_days=None, terms=30):
    inv = []
    for k, d in enumerate(delays):
        due = T - timedelta(days=400 - 30 * k)
        inv.append(dict(no=f"X{k}", amount=100000, inv=due - timedelta(days=terms), due=due, paid=due + timedelta(days=d)))
    for k, od in enumerate(open_overdue_days or []):
        due = T - timedelta(days=od)
        inv.append(dict(no=f"O{k}", amount=100000, inv=due - timedelta(days=terms), due=due, paid=None))
    return dict(id=999, name="Test", terms=terms, kept=kept, broken=broken, type="Distributor", years=5,
                source="current", invoices=inv)


class TestScore(unittest.TestCase):
    def test_on_time_payer_is_good(self):
        b = cr.behaviour(cust([0, 1, 0, 2, 1, 0, 1, 0, 1, 2], kept=5, broken=0), T)
        self.assertLess(b["own_score"], 10)
        self.assertEqual(cr.risk_class(b["own_score"]), cr.FULL)

    def test_very_late_erratic_payer_is_risky(self):
        b = cr.behaviour(cust([40, 60, 30, 75, 50, 90, 45, 70], kept=1, broken=6, open_overdue_days=[70]), T)
        self.assertEqual(cr.risk_class(b["own_score"]), cr.ADVANCE)

    def test_lateness_points(self):
        b = cr.behaviour(cust([45] * 8), T)       # 45 days late = full 25 lateness points
        self.assertAlmostEqual(b["points"]["Lateness"], 25)
        self.assertAlmostEqual(b["points"]["Unpredictability"], 0)

    def test_slowing_customer_uses_recent_delay(self):
        b = cr.behaviour(cust([5, 5, 6, 5, 4, 5, 20, 22, 21, 23]), T)
        self.assertTrue(b["slowing"])
        self.assertGreaterEqual(b["typical"], 20)
        self.assertEqual(b["points"]["Slowing down"], 10)

    def test_overdue_now_points(self):
        b = cr.behaviour(cust([5] * 8, open_overdue_days=[60]), T)
        self.assertAlmostEqual(b["points"]["Overdue now"], 15)

    def test_class_bands(self):
        self.assertEqual(cr.risk_class(30), cr.FULL)
        self.assertEqual(cr.risk_class(31), cr.LIMITED)
        self.assertEqual(cr.risk_class(56), cr.ADVANCE)


class TestSimilarity(unittest.TestCase):
    def test_distance_same_profile_is_zero(self):
        p = dict(type="Govt/PSU", years=10, order=200000, terms=60)
        self.assertEqual(cr.distance(p, p), 0)

    def test_type_matters_most(self):
        a = dict(type="Govt/PSU", years=10, order=200000, terms=60)
        same_type = dict(type="Govt/PSU", years=2, order=50000, terms=30)
        other_type = dict(type="SME manufacturer", years=10, order=200000, terms=60)
        self.assertLess(cr.distance(a, same_type), cr.distance(a, other_type))


class TestModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = cr.RiskModel()

    def test_every_customer_gets_a_class(self):
        for c in self.m.custs.values():
            self.assertIn(c["b"]["class"], cr.CLASSES)

    def test_new_customer_with_no_history_uses_similar_customers(self):
        b = self.m.find("Epsilon Stores (new)")["b"]
        self.assertEqual(b["n"], 0)
        self.assertIsNotNone(b["similar"])

    def test_new_customer_prediction_lists_neighbours(self):
        p = self.m.predict_new("Trader/Retailer", 2, 120000, 30)
        self.assertEqual(len(p["neighbours"]), 5)
        self.assertTrue(all(n[1] == "Trader/Retailer" for n in p["neighbours"][:3]))

    def test_govt_predicted_slower_than_sme(self):
        g = self.m.predict_new("Govt/PSU", 15, 300000, 60)
        s = self.m.predict_new("SME manufacturer", 15, 150000, 30)
        self.assertGreater(g["typical"], s["typical"])

    def test_deal_advance_only_customer(self):
        d = self.m.deal(100000, 30, customer=self.m.find("Ashok Industries"))
        self.assertEqual(d["cls"], cr.ADVANCE)
        self.assertGreaterEqual(d["advance"], 50000)
        self.assertTrue(any("overdue" in a for a in d["plan"]["actions"]))

    def test_over_limit_limited_customer_gets_no_new_credit(self):
        d = self.m.deal(300000, 30, customer=self.m.find("Delta Traders"))
        self.assertEqual(d["cls"], cr.LIMITED)
        self.assertEqual(d["plan"]["on_credit"], 0)

    def test_promise_breaker_gets_post_dated_cheque(self):
        d = self.m.deal(50000, 15, customer=self.m.find("Gamma Boutique"))
        self.assertTrue(any("post-dated cheque" in a for a in d["plan"]["actions"]))


    def test_deal_expected_date_after_due(self):
        d = self.m.deal(150000, 30, customer=self.m.find("Alpha Retail"))
        self.assertGreaterEqual(d["expected"], d["due"])
        self.assertGreaterEqual(d["bad_case"], d["expected"])

    def test_backtest_beats_naive_guess(self):
        r = self.m.backtest()
        self.assertGreater(r["exact"], r["baseline_hits"])


class TestActionPlan(unittest.TestCase):
    def test_limited_shortens_terms(self):
        p = cr.action_plan(cr.LIMITED, 100000, 30, 15, limit=500000, owed=0, overdue=0, today=T)
        self.assertEqual(p["terms"], 15)
        self.assertLess(p["arrival_planned"], p["arrival_asked"])

    def test_limited_default_safeguard_is_25pct_advance(self):
        p = cr.action_plan(cr.LIMITED, 100000, 30, 10, limit=500000, owed=0, overdue=0, today=T)
        self.assertEqual(p["advance"], 25000)

    def test_unpredictable_payer_gets_split_delivery(self):
        p = cr.action_plan(cr.LIMITED, 100000, 30, 10, limit=500000, owed=0, overdue=0, today=T,
                           sig=dict(unpredictable=True))
        self.assertTrue(any("Split the order" in a for a in p["actions"]))

    def test_full_credit_keeps_terms(self):
        p = cr.action_plan(cr.FULL, 100000, 45, 5, limit=500000, owed=0, overdue=0, today=T)
        self.assertEqual(p["terms"], 45)
        self.assertEqual(p["advance"], 0)

    def test_shortest_offer_is_15_days(self):
        p = cr.action_plan(cr.LIMITED, 100000, 30, 40, limit=500000, owed=0, overdue=0, today=T)
        self.assertEqual(p["terms"], 15)


if __name__ == "__main__":
    unittest.main()
