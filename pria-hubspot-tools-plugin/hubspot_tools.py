"""pria-hubspot-tools — read-only HubSpot CRM access through the Capability Gateway.

The agent never holds a HubSpot credential. Each tool maps to a HUBSPOT_* subject;
Pria resolves the institution's service key server-side, calls HubSpot, and
returns the shaped result. Egress from an agent VM is unenforced, so a credential
in here would be exfiltratable with no log — keeping it out makes that impossible
rather than merely discouraged.

Tenancy is derived SERVER-side from the machine principal. Nothing in these
schemas carries an institution or user id, because the caller does not get to
choose whose CRM it reads.
"""

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
MAX_PAYLOAD_BYTES = 200_000

TOOL_SUBJECTS = {
    "hubspot_whoami": "HUBSPOT_WHOAMI",
    "hubspot_search": "HUBSPOT_SEARCH",
    "hubspot_list": "HUBSPOT_LIST",
    "hubspot_get": "HUBSPOT_GET",
    "hubspot_pipelines": "HUBSPOT_PIPELINES",
    "hubspot_owners": "HUBSPOT_OWNERS",
    "hubspot_properties_get": "HUBSPOT_PROPERTIES_GET",
    "hubspot_properties_search": "HUBSPOT_PROPERTIES_SEARCH",
    "hubspot_deal_update": "HUBSPOT_DEAL_UPDATE",
    "hubspot_contact_update": "HUBSPOT_CONTACT_UPDATE",
    "hubspot_company_update": "HUBSPOT_COMPANY_UPDATE",
    "hubspot_deal_create": "HUBSPOT_DEAL_CREATE",
    # Marketing campaigns — read-only, all GET.
    "hubspot_campaigns_list": "HUBSPOT_CAMPAIGNS_LIST",
    "hubspot_campaign_get": "HUBSPOT_CAMPAIGN_GET",
    "hubspot_campaign_metrics": "HUBSPOT_CAMPAIGN_METRICS",
    "hubspot_campaign_assets": "HUBSPOT_CAMPAIGN_ASSETS",
    "hubspot_campaign_contacts": "HUBSPOT_CAMPAIGN_CONTACTS",
    "hubspot_campaign_revenue": "HUBSPOT_CAMPAIGN_REVENUE",
    # Content analytics + association-label discovery — read-only, both GET.
    "hubspot_content_analytics": "HUBSPOT_CONTENT_ANALYTICS",
    "hubspot_association_labels": "HUBSPOT_ASSOCIATION_LABELS",
    # Second write slice.
    "hubspot_deal_associate": "HUBSPOT_DEAL_ASSOCIATE",
    "hubspot_contact_create": "HUBSPOT_CONTACT_CREATE",
    "hubspot_company_create": "HUBSPOT_COMPANY_CREATE",
}

OBJECT_TYPES = ["companies", "contacts", "deals"]
PIPELINE_TYPES = ["deals", "tickets"]
MATCH_MODES = ["contains", "prefix", "exact"]
CAMPAIGN_PROPERTIES = ["hs_name", "hs_start_date", "hs_end_date", "hs_goal", "hs_audience",
                       "hs_notes", "hs_owner", "hs_currency_code", "hs_campaign_status", "hs_utm",
                       "hs_object_id", "hs_color_hex", "hs_created_by_user_id",
                       "hs_budget_items_sum_amount", "hs_spend_items_sum_amount"]
CAMPAIGN_ASSET_TYPES = ["AD_CAMPAIGN", "AUTOMATION_PLATFORM_FLOW", "BLOG_POST", "CALL",
                        "CASE_STUDY", "CTA", "EMAIL", "EXTERNAL_WEB_URL", "FEEDBACK_SURVEY",
                        "FILE_MANAGER_FILE", "FORM", "KNOWLEDGE_ARTICLE", "LANDING_PAGE",
                        "MARKETING_EMAIL", "MARKETING_EVENT", "MARKETING_SMS", "MEDIA",
                        "MEETING_EVENT", "OBJECT_LIST", "PLAYBOOK", "PODCAST_EPISODE",
                        "SALES_DOCUMENT", "SEQUENCE", "SITE_PAGE", "SOCIAL_BROADCAST",
                        "WEB_INTERACTIVE"]
CAMPAIGN_CONTACT_TYPES = ["contactFirstTouch", "contactLastTouch", "influencedContacts"]
_CAMPAIGN_ID = ("Campaign GUID, 36 chars, e.g. 3aed6cd1-d85f-4cef-a6bd-531f3f554064. "
                "NOT a numeric CRM record id — get it from hubspot_campaigns_list.")
_CAMPAIGN_PROPS = ("Optional campaign property names. Omit for a lean default "
                   "(hs_name, hs_campaign_status, hs_start_date, hs_end_date, hs_owner). "
                   "Any name outside the enum is refused, because HubSpot 400s on it.")
_ANALYTICS_DATE = ("YYYYMMDD with NO DASHES, e.g. 20260131. This is NOT the format "
                   "hubspot_campaign_revenue takes (that one is YYYY-MM-DD). Required.")
FILTER_OPERATORS = ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN",
                    "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN"]
_PROPS = ("Optional list of HubSpot property names. Omit for a sensible default set.")

TOOL_SPECS = [
    {
        "name": "hubspot_whoami",
        "description": ("Verify HubSpot access and report which portal this institution is "
                        "connected to. Run FIRST when diagnosing any HubSpot problem — it "
                        "separates a bad token from a missing scope. Never raises."),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "hubspot_search",
        "description": ("Search the CRM. PREFER THIS OVER hubspot_list whenever you know what "
                        "you are looking for — one filtered search replaces many pages of "
                        "listing, and returns only the rows you need instead of everything. "
                        "Supports free-text `query`, typed `filters` (ANDed), `filter_groups` "
                        "(ORed), and `sort_by`. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "query": {"type": "string", "description": "Free-text search string."},
                "filters": {
                    "type": "array",
                    "description": ("Typed conditions, ALL of which must match (AND). Each is "
                                    "{property, operator, value}. Example: find won deals over "
                                    "$10k — [{\"property\":\"dealstage\",\"operator\":\"EQ\","
                                    "\"value\":\"contractsent\"},{\"property\":\"amount\","
                                    "\"operator\":\"GT\",\"value\":\"10000\"}]"),
                    "items": {
                        "type": "object",
                        "properties": {
                            "property": {"type": "string", "description": "HubSpot property name, e.g. dealstage, amount, pipeline."},
                            "operator": {"type": "string", "enum": FILTER_OPERATORS},
                            "value": {"type": "string", "description": "Value for most operators; low bound for BETWEEN."},
                            "highValue": {"type": "string", "description": "Upper bound, BETWEEN only."},
                            "values": {"type": "array", "items": {"type": "string"},
                                       "description": "Value list, IN / NOT_IN only (max 100)."},
                        },
                        "required": ["property", "operator"],
                    },
                },
                "filter_groups": {
                    "type": "array",
                    "description": ("Advanced: array of filter arrays. Groups are ORed together, "
                                    "conditions within a group are ANDed. Use only when a single "
                                    "AND group cannot express the question. Max 5 groups."),
                    "items": {"type": "array", "items": {"type": "object"}},
                },
                "sort_by": {"type": "string", "description": "Property to sort by, e.g. amount. Avoids paging to find extremes."},
                "sort_direction": {"type": "string", "enum": ["ASCENDING", "DESCENDING"],
                                   "description": "Default DESCENDING."},
                "properties": {"type": "array", "items": {"type": "string"}, "description": _PROPS},
                "limit": {"type": "integer", "description": "Max records (1-100, default 10)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
            "required": ["object_type"],
        },
    },
    {
        "name": "hubspot_list",
        "description": ("Page through CRM records of one type, unfiltered. Use ONLY for an "
                        "unbiased sample of what exists — if you have any criteria at all, use "
                        "hubspot_search with `filters` instead, which is far cheaper than paging "
                        "this one. Order is by record id and is NOT chronological — never infer "
                        "recency from position. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "properties": {"type": "array", "items": {"type": "string"}, "description": _PROPS},
                "limit": {"type": "integer", "description": "Max records (1-100, default 10)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
            "required": ["object_type"],
        },
    },
    {
        "name": "hubspot_get",
        "description": "Fetch ONE CRM record by its numeric id, with full properties. Read-only.",
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "object_id": {"type": "string", "description": "Numeric HubSpot record id."},
                "properties": {"type": "array", "items": {"type": "string"}, "description": _PROPS},
            },
            "required": ["object_type", "object_id"],
        },
    },
    {
        "name": "hubspot_pipelines",
        "description": ("List pipelines and their stages (id, label, order, closed flag, probability). "
                        "REQUIRED to interpret a raw dealstage id — stage ids frequently do not match "
                        "their business meaning, so always resolve the label before describing a deal."),
        "input_schema": {
            "type": "object",
            "properties": {"pipeline_type": {"type": "string", "enum": PIPELINE_TYPES,
                                             "description": "Defaults to 'deals'."}},
        },
    },
    {
        "name": "hubspot_owners",
        "description": "List CRM owners (reps) so an ownerId on a record resolves to a person.",
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "Max owners (1-100, default 50)."}},
        },
    },
    {
        "name": "hubspot_properties_search",
        "description": ("Find a HubSpot property by a fragment of its name or label — "
                        "e.g. 'renew', 'owner', 'close date'. USE THIS BEFORE writing a "
                        "`filters` entry for hubspot_search when you are unsure of the "
                        "exact property name: a guessed name does not error, it silently "
                        "matches nothing and you will be tempted to page hubspot_list "
                        "instead. Returns a handful of {name, label, type} records, and "
                        "close suggestions when nothing matches. Cheaper than "
                        "hubspot_properties_get, which returns the whole catalogue."),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "q": {"type": "string",
                      "description": ("Name or label fragment, max 64 chars. Letters, digits, "
                                      "spaces, underscore, dot and hyphen only. Separator-"
                                      "insensitive: 'close date' finds `closedate`.")},
                "match": {"type": "string", "enum": MATCH_MODES,
                          "description": "Default 'contains'. 'prefix' and 'exact' are literal."},
                "include_options": {"type": "boolean",
                                    "description": ("Include enumeration choices (max 25 per "
                                                    "property). Must be a real boolean.")},
                "limit": {"type": "integer", "description": "Max matches (1-50, default 20)."},
            },
            "required": ["object_type", "q"],
        },
    },
    {
        "name": "hubspot_properties_get",
        "description": ("List the filterable property definitions for one object type. Call "
                        "this BEFORE using `filters` on hubspot_search if you are not certain "
                        "a property name exists — guessed names silently return nothing. "
                        "Returns lean {name, label, type} records, not full schemas. If "
                        "`truncated` is true, re-call with `group_name` rather than paging "
                        "`offset`. If you already know roughly what you want, "
                        "hubspot_properties_search is cheaper."),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "group_name": {"type": "string",
                               "description": ("Restrict to one property group, e.g. "
                                               "dealinformation. Read the `groups` array from a "
                                               "previous call. Letters, digits and underscore only.")},
                "include_options": {"type": "boolean",
                                    "description": ("Include enumeration choices (max 25 per "
                                                    "property). Must be a real boolean.")},
                "include_hidden": {"type": "boolean",
                                   "description": ("Include HubSpot internal bookkeeping "
                                                   "properties. Rarely useful. Must be a real boolean.")},
                "limit": {"type": "integer", "description": "Max properties (1-100, default 40)."},
                "offset": {"type": "integer",
                           "description": ("Skip this many properties (0-5000). Prefer "
                                           "`group_name` over walking offset.")},
            },
            "required": ["object_type"],
        },
    },
    {
        "name": "hubspot_deal_update",
        "description": (
            "Update properties on ONE existing deal. THIS MUTATES THE CRM. "
            "It is a DRY RUN unless you pass dry_run=false — a dry run returns "
            "the exact before/after it WOULD write and changes nothing, so use "
            "it to show the user the change before applying. "
            "Moving a deal between stages needs stage_id AND stage_label_confirm: "
            "the label HubSpot reports for that stage, which you must read from "
            "hubspot_pipelines first. Do not guess it — stage ids in this portal "
            "do NOT match their labels, and a wrong guess is refused, not applied. "
            "Moving a deal into a CLOSED stage is destructive and additionally "
            "requires confirm=true and a non-empty reason. "
            "Use hubspot_properties_search to confirm a property name exists "
            "before writing it."),
        "input_schema": {
            "type": "object",
            "properties": {
                "deal_id": {"type": "string", "description": "Numeric HubSpot deal id."},
                "properties": {
                    "type": "object",
                    "description": ("Property name -> new value. Values must be string, "
                                    "number or boolean. Only writable deal properties are "
                                    "accepted; anything else is refused, not ignored."),
                },
                "stage_id": {"type": "string", "description": "Raw dealstage id to move to. Requires stage_label_confirm."},
                "stage_label_confirm": {
                    "type": "string",
                    "description": ("The label HubSpot reports for stage_id, read from "
                                    "hubspot_pipelines. Adjudicated against the live label; "
                                    "trim/case/whitespace differences are tolerated, changed "
                                    "content is refused."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually apply the change."},
                "confirm": {"type": "boolean", "description": "Required (true) only for destructive changes, e.g. moving into a closed stage."},
                "reason": {"type": "string", "description": "Required, non-empty, for destructive changes. Say why."},
                "idempotency_key": {"type": "string", "description": "Optional. Replaying the same key returns the original receipt instead of writing twice."},
            },
            "required": ["deal_id"],
        },
    },
    {
        "name": "hubspot_contact_update",
        "description": (
            "Update properties on ONE existing contact. THIS MUTATES THE CRM. "
            "It is a DRY RUN unless you pass dry_run=false — a dry run returns "
            "the exact before/after it WOULD write and changes nothing, so use "
            "it to show the user the change before applying. "
            "Writable properties are ONLY: firstname, lastname, email, phone, "
            "jobtitle, company. Anything else is refused, not ignored — that "
            "includes lifecyclestage, which is not writable here at all. "
            "CHANGING email IS DESTRUCTIVE: email is HubSpot's deduplication "
            "key, and writing an address another contact already holds can MERGE "
            "the two records irreversibly. It requires confirm=true and a reason "
            "of at least 12 characters. Take the contact_id from hubspot_search "
            "or hubspot_get; this tool will not look a contact up by email."),
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string", "description": "Numeric HubSpot contact id."},
                "properties": {
                    "type": "object",
                    "description": ("Property name -> new value. Values must be string, "
                                    "number or boolean. Only firstname, lastname, email, "
                                    "phone, jobtitle and company are accepted; anything "
                                    "else is refused, not ignored."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually apply the change."},
                "confirm": {"type": "boolean", "description": "Required (true) when writing `email`, which can merge two contacts."},
                "reason": {"type": "string", "description": "Required, 12+ chars, when writing `email`. Say why."},
                "idempotency_key": {"type": "string", "description": "Optional. Replaying the same key returns the original receipt instead of writing twice."},
            },
            "required": ["contact_id", "properties"],
        },
    },
    {
        "name": "hubspot_company_update",
        "description": (
            "Update properties on ONE existing company. THIS MUTATES THE CRM. "
            "It is a DRY RUN unless you pass dry_run=false — a dry run returns "
            "the exact before/after it WOULD write and changes nothing. "
            "Writable properties are ONLY: name, domain, industry, city, state, "
            "country, phone. Anything else is refused, not ignored — that "
            "includes lifecyclestage and the parent-company link. "
            "CHANGING domain IS DESTRUCTIVE: domain is HubSpot's deduplication "
            "AND auto-association key, so a wrong value can merge two companies "
            "along with their deals and contacts, or quietly stop future records "
            "linking to this account. It requires confirm=true and a reason of at "
            "least 12 characters, and it must be a BARE HOSTNAME — 'example.com', "
            "never 'https://example.com', never 'www.example.com', no path or "
            "port. A URL is refused, not cleaned up for you."),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_id": {"type": "string", "description": "Numeric HubSpot company id."},
                "properties": {
                    "type": "object",
                    "description": ("Property name -> new value. Values must be string, "
                                    "number or boolean. Only name, domain, industry, city, "
                                    "state, country and phone are accepted; anything else "
                                    "is refused, not ignored."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually apply the change."},
                "confirm": {"type": "boolean", "description": "Required (true) when writing `domain`, which can merge two companies."},
                "reason": {"type": "string", "description": "Required, 12+ chars, when writing `domain`. Say why."},
                "idempotency_key": {"type": "string", "description": "Optional. Replaying the same key returns the original receipt instead of writing twice."},
            },
            "required": ["company_id", "properties"],
        },
    },
    {
        "name": "hubspot_deal_create",
        "description": (
            "CREATE a new deal. THIS MUTATES THE CRM. It is a DRY RUN unless you "
            "pass dry_run=false — a dry run returns the exact payload it WOULD "
            "post and creates nothing, so use it to show the user the deal before "
            "creating it. "
            "You must supply pipeline_id AND stage_id, and for each one the label "
            "HubSpot reports for it. Call hubspot_pipelines FIRST and copy the "
            "labels from it. Do not guess: stage ids in this portal do NOT match "
            "their labels, and a wrong guess is refused, not applied. "
            "Some early-SOUNDING stages are marked closed in this portal, so "
            "creating a deal in one is destructive and additionally needs "
            "confirm=true and a reason. "
            "idempotency_key is REQUIRED when dry_run=false, because creating is "
            "not repeatable — without it a retry makes a second deal. "
            "This tool does NOT associate the deal with any contact or company. "
            "The new deal is orphaned; tell the user a human has to link it."),
        "input_schema": {
            "type": "object",
            "properties": {
                "properties": {
                    "type": "object",
                    "description": ("Property name -> value. Must include `dealname`. "
                                    "Only dealname, amount, closedate, dealtype, "
                                    "description and hubspot_owner_id are accepted. "
                                    "Do NOT put `pipeline` or `dealstage` here — use the "
                                    "typed arguments."),
                },
                "pipeline_id": {"type": "string", "description": "Raw pipeline id from hubspot_pipelines. Never guessed, never defaulted."},
                "pipeline_label_confirm": {
                    "type": "string",
                    "description": ("The label HubSpot reports for pipeline_id, read from "
                                    "hubspot_pipelines. Adjudicated against the live label; "
                                    "changed content is refused."),
                },
                "stage_id": {"type": "string", "description": "Raw dealstage id for the deal's initial stage."},
                "stage_label_confirm": {
                    "type": "string",
                    "description": ("The label HubSpot reports for stage_id, read from "
                                    "hubspot_pipelines. Stage ids in this portal do NOT "
                                    "match their labels; a wrong claim is refused."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually create the deal."},
                "confirm": {"type": "boolean", "description": "Required (true) only when the chosen stage is marked closed in HubSpot."},
                "reason": {"type": "string", "description": "Required, 12+ chars, when the chosen stage is closed. Say why."},
                "idempotency_key": {
                    "type": "string",
                    "description": ("REQUIRED when dry_run=false. 8-64 chars of A-Z a-z 0-9 _ -. "
                                    "Replaying the same key returns the original receipt "
                                    "instead of creating a duplicate deal."),
                },
            },
            "required": ["properties", "pipeline_id", "pipeline_label_confirm",
                         "stage_id", "stage_label_confirm"],
        },
    },
    {
        "name": "hubspot_campaigns_list",
        "description": ("List marketing campaigns. START HERE for anything about a SEND or a "
                        "MARKETING PUSH — campaigns are the lens for 'what happened when we "
                        "emailed/advertised', which the CRM object tools cannot answer. Returns "
                        "the campaign GUID you need for every other campaign tool. Note "
                        "`properties` come back EMPTY unless requested, so a lean default set "
                        "is always sent. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "properties": {"type": "array", "items": {"type": "string", "enum": CAMPAIGN_PROPERTIES},
                               "description": _CAMPAIGN_PROPS},
                "limit": {"type": "integer", "description": "Max campaigns (1-100, default 10)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
        },
    },
    {
        "name": "hubspot_campaign_get",
        "description": ("Fetch ONE campaign by GUID, plus an index of the assets attached to it "
                        "(emails, forms, ads, pages...) grouped by asset type. Use this to find "
                        "out WHAT a campaign was made of; use hubspot_campaign_metrics for how "
                        "it performed. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "campaign_id": {"type": "string", "description": _CAMPAIGN_ID},
                "properties": {"type": "array", "items": {"type": "string", "enum": CAMPAIGN_PROPERTIES},
                               "description": _CAMPAIGN_PROPS},
            },
            "required": ["campaign_id"],
        },
    },
    {
        "name": "hubspot_campaign_metrics",
        "description": ("ENGAGEMENT for one campaign: sessions, new contacts by first touch, new "
                        "contacts by last touch, and influenced contacts. This is the fastest "
                        "answer to 'did that send do anything'. Aggregate counters only — no "
                        "per-person data. For WHO was touched use hubspot_campaign_contacts; "
                        "for MONEY use hubspot_campaign_revenue. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {"campaign_id": {"type": "string", "description": _CAMPAIGN_ID}},
            "required": ["campaign_id"],
        },
    },
    {
        "name": "hubspot_campaign_assets",
        "description": ("List the assets of ONE type attached to a campaign — e.g. every "
                        "MARKETING_EMAIL, FORM or LANDING_PAGE in it. One asset type per call; "
                        "if you want the whole inventory at a glance call hubspot_campaign_get "
                        "instead, which returns all types at once. Returns {id, name}. An empty "
                        "results array means the campaign simply has none of that type. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "campaign_id": {"type": "string", "description": _CAMPAIGN_ID},
                "asset_type": {"type": "string", "enum": CAMPAIGN_ASSET_TYPES,
                               "description": "Exactly one asset type. Closed enum — no other value exists."},
                "limit": {"type": "integer", "description": "Max assets (1-100, default 50)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
            "required": ["campaign_id", "asset_type"],
        },
    },
    {
        "name": "hubspot_campaign_contacts",
        "description": ("ATTRIBUTION for one campaign: which contacts it is credited with, under "
                        "the attribution model you pick. contactFirstTouch = the campaign that "
                        "first brought them in; contactLastTouch = the campaign that closed the "
                        "loop; influencedContacts = touched anywhere along the way (always the "
                        "largest). Returns CONTACT IDS ONLY, no names or emails — pass an id to "
                        "hubspot_get with object_type 'contacts' if you need the person. "
                        "Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "campaign_id": {"type": "string", "description": _CAMPAIGN_ID},
                "contact_type": {"type": "string", "enum": CAMPAIGN_CONTACT_TYPES,
                                 "description": ("Attribution model. These are three DIFFERENT "
                                                 "questions — do not treat the counts as "
                                                 "interchangeable.")},
                "limit": {"type": "integer", "description": "Max contact ids (1-100, default 50)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
            "required": ["campaign_id", "contact_type"],
        },
    },
    {
        "name": "hubspot_campaign_revenue",
        "description": ("MONEY attributed to one campaign over a date window: revenue amount, "
                        "deal amount, and the number of contacts and deals behind them. Use this "
                        "when the question is 'was it worth it', not 'did anyone click'. "
                        "startDate AND endDate are BOTH REQUIRED (YYYY-MM-DD) — HubSpot refuses "
                        "an unbounded revenue query, so pick an explicit window covering the "
                        "campaign. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "campaign_id": {"type": "string", "description": _CAMPAIGN_ID},
                "startDate": {"type": "string", "description": "Window start, YYYY-MM-DD. Required."},
                "endDate": {"type": "string", "description": "Window end, YYYY-MM-DD. Required, and not before startDate."},
            },
            "required": ["campaign_id", "startDate", "endDate"],
        },
    },
    {
        "name": "hubspot_content_analytics",
        "description": ("Portal-wide CONTENT performance over a date window: views, visits, "
                        "visitors, form submissions, contacts and leads, plus the three "
                        "conversion rates. Use this for 'how is the website/blog doing', which "
                        "no CRM object tool can answer and which campaign tools answer only for "
                        "one send. "
                        "BOTH dates are REQUIRED and are YYYYMMDD WITH NO DASHES (20260131). "
                        "That is a DIFFERENT format from hubspot_campaign_revenue, which takes "
                        "YYYY-MM-DD — do not copy one into the other, it is refused. "
                        "A metric this portal does not report comes back null, never 0; do not "
                        "read a null as 'zero'. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "start": {"type": "string", "description": "Window start. " + _ANALYTICS_DATE},
                "end": {"type": "string", "description": "Window end, not before start. " + _ANALYTICS_DATE},
            },
            "required": ["start", "end"],
        },
    },
    {
        "name": "hubspot_association_labels",
        "description": ("List the association types that exist BETWEEN two object types in this "
                        "portal — each with its numeric typeId and its label (e.g. 'Primary', "
                        "'Billing Contact'). "
                        "CALL THIS BEFORE hubspot_deal_associate, every time. Association type "
                        "ids are PORTAL-SPECIFIC: this portal can define its own labels, so an "
                        "id you remember from anywhere else may link the records into the wrong "
                        "relationship. Never guess an id; read it from here. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "from_object_type": {"type": "string", "enum": OBJECT_TYPES,
                                     "description": "The object the association starts FROM, e.g. deals."},
                "to_object_type": {"type": "string", "enum": OBJECT_TYPES,
                                   "description": "The object the association points TO, e.g. companies."},
            },
            "required": ["from_object_type", "to_object_type"],
        },
    },
    {
        "name": "hubspot_deal_associate",
        "description": (
            "Link ONE existing deal to ONE existing contact or company. THIS "
            "MUTATES THE CRM. It is a DRY RUN unless you pass dry_run=false — a "
            "dry run returns the exact link it WOULD make and changes nothing. "
            "USE THIS AFTER hubspot_deal_create: that tool creates the deal "
            "ORPHANED, attached to nobody, and this is how it gets attached. "
            "CALL hubspot_association_labels FIRST to get association_type_id. "
            "The ids are portal-specific and MUST NOT be guessed or remembered "
            "from another portal — a wrong id makes a link into the wrong "
            "relationship, which looks correct and is not. "
            "association_type_id must be an INTEGER (5, not \"5\"). The "
            "association category is always HUBSPOT_DEFINED and is not yours to "
            "set. Both records must already exist; this creates neither."),
        "input_schema": {
            "type": "object",
            "properties": {
                "deal_id": {"type": "string", "description": "Numeric HubSpot deal id. The deal must already exist."},
                "to_object_type": {"type": "string", "enum": ["contacts", "companies"],
                                   "description": "What to link the deal to."},
                "to_object_id": {"type": "string", "description": "Numeric HubSpot id of the contact or company. It must already exist."},
                "association_type_id": {
                    "type": "integer",
                    "description": ("Numeric association type id, read from "
                                    "hubspot_association_labels for this exact "
                                    "from/to pair. An INTEGER, not a string. "
                                    "Never guessed."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually create the link."},
                "confirm": {"type": "boolean", "description": "Not required by this tool; accepted for consistency."},
                "reason": {"type": "string", "description": "Optional note for the audit receipt."},
                "idempotency_key": {"type": "string", "description": "Optional. Replaying the same key returns the original receipt instead of writing twice."},
            },
            "required": ["deal_id", "to_object_type", "to_object_id", "association_type_id"],
        },
    },
    {
        "name": "hubspot_contact_create",
        "description": (
            "CREATE a new contact. THIS MUTATES THE CRM. It is a DRY RUN unless "
            "you pass dry_run=false — a dry run returns the exact payload it "
            "WOULD post and creates nothing, so use it to show the user the "
            "contact before creating it. "
            "SEARCH FIRST with hubspot_search: creating a contact that already "
            "exists is how duplicates and merges happen. "
            "Writable properties are ONLY: firstname, lastname, email, phone, "
            "jobtitle, company. Anything else is refused, not ignored — that "
            "includes lifecyclestage. At least one of email, firstname or "
            "lastname is required, otherwise the record is a blank row nobody "
            "can find again. "
            "SUPPLYING email IS DESTRUCTIVE: email is HubSpot's deduplication "
            "key, so a value that already belongs to someone else can merge two "
            "people. It requires confirm=true and a reason of at least 12 "
            "characters. "
            "idempotency_key is REQUIRED when dry_run=false, because creating is "
            "not repeatable — without it a retry makes a second contact."),
        "input_schema": {
            "type": "object",
            "properties": {
                "properties": {
                    "type": "object",
                    "description": ("Property name -> value. Values must be string, number "
                                    "or boolean. Only firstname, lastname, email, phone, "
                                    "jobtitle and company are accepted; anything else is "
                                    "refused, not ignored."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually create the contact."},
                "confirm": {"type": "boolean", "description": "Required (true) when supplying `email`, which can merge two contacts."},
                "reason": {"type": "string", "description": "Required, 12+ chars, when supplying `email`. Say why."},
                "idempotency_key": {
                    "type": "string",
                    "description": ("REQUIRED when dry_run=false. 8-64 chars of A-Z a-z 0-9 _ -. "
                                    "Replaying the same key returns the original receipt "
                                    "instead of creating a duplicate contact."),
                },
            },
            "required": ["properties"],
        },
    },
    {
        "name": "hubspot_company_create",
        "description": (
            "CREATE a new company. THIS MUTATES THE CRM. It is a DRY RUN unless "
            "you pass dry_run=false — a dry run returns the exact payload it "
            "WOULD post and creates nothing. "
            "SEARCH FIRST with hubspot_search: creating a company that already "
            "exists is how duplicates and merges happen. "
            "Writable properties are ONLY: name, domain, industry, city, state, "
            "country, phone. Anything else is refused, not ignored — that "
            "includes lifecyclestage and the parent-company link. `name` is "
            "required. "
            "SUPPLYING domain IS DESTRUCTIVE: domain is HubSpot's deduplication "
            "AND auto-association key, so a wrong value can merge two companies "
            "along with their deals and contacts. It requires confirm=true and a "
            "reason of at least 12 characters, and it must be a BARE HOSTNAME — "
            "'example.com', never 'https://example.com', never 'www.example.com'. "
            "A URL is refused, not cleaned up for you. "
            "idempotency_key is REQUIRED when dry_run=false, because creating is "
            "not repeatable — without it a retry makes a second company."),
        "input_schema": {
            "type": "object",
            "properties": {
                "properties": {
                    "type": "object",
                    "description": ("Property name -> value. Values must be string, number "
                                    "or boolean. Only name, domain, industry, city, state, "
                                    "country and phone are accepted; anything else is "
                                    "refused, not ignored. `name` is required."),
                },
                "dry_run": {"type": "boolean", "description": "Defaults TRUE. Pass false to actually create the company."},
                "confirm": {"type": "boolean", "description": "Required (true) when supplying `domain`, which can merge two companies."},
                "reason": {"type": "string", "description": "Required, 12+ chars, when supplying `domain`. Say why."},
                "idempotency_key": {
                    "type": "string",
                    "description": ("REQUIRED when dry_run=false. 8-64 chars of A-Z a-z 0-9 _ -. "
                                    "Replaying the same key returns the original receipt "
                                    "instead of creating a duplicate company."),
                },
            },
            "required": ["properties"],
        },
    },
]

class ToolError(RuntimeError):
    """An actionable failure to surface to the model."""


def validate(name, payload):
    """Convenience gate, NOT the security boundary — the gateway re-validates."""
    if name not in TOOL_SUBJECTS:
        raise ToolError(f"unknown tool '{name}'")
    if not isinstance(payload, dict):
        raise ToolError("input must be an object")
    spec = next(t for t in TOOL_SPECS if t["name"] == name)
    for req in spec["input_schema"].get("required", []):
        if not payload.get(req):
            raise ToolError(f"'{req}' is required")
    if len(json.dumps(payload)) > MAX_PAYLOAD_BYTES:
        raise ToolError("input too large")
    return payload


class GatewayClient:
    def __init__(self, token, base_url=DEFAULT_BASE, opener=None):
        if not token:
            raise ToolError("pria_agent_tool_token not configured")
        self.token, self.base_url = token, base_url.rstrip("/")
        self.opener = opener or urllib.request.urlopen

    def call(self, subject, args):
        req = urllib.request.Request(
            f"{self.base_url}/internal/agent-tool-call",
            data=json.dumps({"subject": subject, "args": args}).encode("utf-8"),
            method="POST",
        )
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        try:
            response = self.opener(req, timeout=30)
            payload = json.loads(response.read().decode("utf-8"))
            response.close()
        except urllib.error.HTTPError as exc:
            raise ToolError(f"gateway request failed ({exc.code})") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise ToolError("gateway request failed") from exc
        if not payload.get("success"):
            raise ToolError("gateway request denied")
        return payload.get("result") or {}


def configured_client(config):
    token = (os.environ.get("PRIA_AGENT_TOOL_TOKEN")
             or config.get("pria_agent_tool_token") or "").strip()
    base = (config.get("pria_api_base") or DEFAULT_BASE).strip()
    return GatewayClient(token, base)


def dispatch(name, tool_input, config):
    args = validate(name, tool_input or {})
    return configured_client(config).call(TOOL_SUBJECTS[name], args)
