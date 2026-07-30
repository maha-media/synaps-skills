import unittest
from twin_tools import TOOL_SUBJECTS, ToolError, validate

class TwinToolsTests(unittest.TestCase):
    def test_tool_surface_is_closed(self):
        self.assertEqual(set(TOOL_SUBJECTS), {
            'read_twin_profile', 'create_twin_improvement_proposal',
            'get_twin_improvement_run', 'create_twin_evaluation',
            'create_conversation_insights',
        })

    def test_proposal_rejects_unknown_fields(self):
        with self.assertRaises(ToolError):
            validate('create_twin_improvement_proposal', {'goal': 'support', 'audience': 'customers', 'admin': True})

    def test_evaluation_bounds_questions(self):
        with self.assertRaises(ToolError):
            validate('create_twin_evaluation', {'purpose': 'launch', 'audience': 'customers', 'questions': []})
        self.assertEqual(validate('create_twin_evaluation', {'purpose': 'launch', 'audience': 'customers', 'questions': ['What is your refund policy?']})['purpose'], 'launch')

    def test_conversation_insights_requires_date_range(self):
        with self.assertRaises(ToolError):
            validate('create_conversation_insights', {'purpose': 'review', 'after': '', 'before': '2026-07-29T00:00:00Z'})

if __name__ == '__main__':
    unittest.main()
