"""The Notion port: the rules of an edit (`changes`), the applier contract and the apply loop
(`apply`), and a fake applier (`fake`). Nothing in this package talks to Notion: the live applier
is a later, owner-approved step (design §11), and no Notion key is read here.
"""
