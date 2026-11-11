"""Add paired scenarios to the original dataset."""
from copy import deepcopy
import json
from pathlib import Path
from build_fixtures import add, cases, check, doc, turn

def pair(id, split, category, polished, chat, criteria, **kwargs):
    for style, prompt in (("polished", polished), ("chat", chat)):
        add(f"{id}-{style}", split, category, prompt, criteria, **kwargs)
        cases[-1].update(pair_id=id, prompt_style=style)

def past(id, product, excerpt, at="2026-11-09T08:00:00Z"):
    return doc(id, excerpt, [product.lower()], observed=at)

pair("d11","dev","commitment","Identify which promised deliverable remains outstanding and its deadline.",
     "what do i still owe leena btw? when'd i say i'd send it?",
     [check("The user still owes Leena the API examples by Thursday at 3 PM.")],
     history=[turn("leena-a","2026-11-09T08:00:00Z","I promised Leena the API examples by Thursday at 3 PM and a draft diagram today.","Recorded."),
              turn("leena-b","2026-11-10T08:00:00Z","Sent Leena the diagram. Still need to do the examples.","Recorded.")],
     route="recall",recall=["leena-a","leena-b"],forbid=["Lists the diagram as still owed."])

pair("d12","dev","historical_update","Recheck AmberQueue's current Starter monthly price against our November 9 conversation.",
     "amberqueue starter we checked nov 9, still 14 bucks/mo or nah?",
     [check("Reports $14 to $18 per month on like-for-like US Starter terms.",["amber-old","amber-new"])],
     history=[turn("amber-turn","2026-11-09T08:05:00Z","What is AmberQueue's Starter price?","US monthly Starter is $14.",
                   evidence=[past("amber-old","AmberQueue","AmberQueue US Starter costs $14 USD per month on monthly billing.")])],
     evidence=[doc("amber-new","AmberQueue US Starter now costs $18 USD per month on monthly billing.",["amberqueue"])],
     route="historical_update",recall=["amber-turn"],cover=["AmberQueue"])

pair("d13","dev","evidence","What are JuniperSync's per-workspace transfer allowance and reset interval?",
     "junipersync whats the transfer cap again per workspace? when does it reset?",
     [check("Reports 100 GB per workspace and reset on the first day of each calendar month.",["juniper-help"])],
     evidence=[doc("juniper-help","JuniperSync Basic transfer quota: 100 GB per workspace. It resets on the first day of each calendar month.",["junipersync"]),
               doc("juniper-noise","JuniperSync downloads may use 500 GB of local disk space.",["junipersync"])],
     route="research",cover=["JuniperSync"],forbid=["Treats local disk space as transfer quota."])

pair("d14","dev","restraint","Rewrite this message in a warmer tone: I need the review by noon.",
     "make this nicer pls: need the review by noon",
     [check("Provides a concise warmer rewrite that preserves noon.")],
     forbid=["Claims the message was sent."])

old_a = past("nacre-old","NacreDesk","NacreDesk Team, US, $20 USD per seat per month, billed monthly, 20 seats.")
old_b = past("loam-old","LoamDesk","LoamDesk Team, US, $30 USD per seat per month, billed monthly, 20 seats.")
pair("h17","holdout","historical_update",
     "Verify both tools from our Monday shortlist against their current US monthly-billed Team prices for 20 seats. Cite the old and new evidence.",
     "the 2 helpdesk ones from monday for 20 ppl — prices still the same? monthly pls",
     [check("Reports NacreDesk $20 to $23 on comparable terms.",["nacre-old","nacre-current"]),
      check("Reports LoamDesk only shows $24 on annual billing and the monthly price change is unverified.",["loam-old","loam-annual"])],
     history=[turn("helpdesk-mon","2026-11-09T08:05:00Z","Compare NacreDesk and LoamDesk for a US 20-seat monthly Team helpdesk.",
                   "NacreDesk $20 and LoamDesk $30 per seat per month.",evidence=[old_a,old_b]),
              turn("helpdesk-tue","2026-11-10T08:05:00Z","Compare LoamDesk and FlintDesk for an EU five-seat annual plan.","Different shortlist.","later")],
     evidence=[doc("nacre-current","NacreDesk Team, US, $23 USD per seat per month, billed monthly for 20 seats.",["nacredesk"]),
               doc("loam-annual","LoamDesk Team US, 20 seats. $24 USD per seat per month. Annual billing required.",["loamdesk"])],
     route="historical_update",recall=["helpdesk-mon"],cover=["NacreDesk","LoamDesk"],restart=True,
     forbid=["Includes FlintDesk.", "Claims LoamDesk's monthly price decreased."])

pair("h18","holdout","dated_memory","List the two questions I asked on 9 November in my timezone.",
     "what were my 2 asks on the 9th again? my time",
     [check("Includes the production rollback question and the hotel cancellation question.")],
     history=[turn("roll","2026-11-08T19:05:00Z","How do we roll back production?","Use the approved rollback plan.","engineering"),
              turn("hotel","2026-11-09T18:20:00Z","When is free hotel cancellation over?","Check the booking.","travel"),
              turn("other-day","2026-11-09T18:40:00Z","Who has the key to the event room?","Ask Kim.","events")],
     route="recall",recall=["roll","hotel"],forbid=["Includes the event room question."])

pair("h19","holdout","commitment","Which of the review actions belongs to me and remains open?",
     "quick remind me what i still gotta do from review, just mine",
     [check("The user still owes the accessibility notes.")],
     history=[turn("review-1","2026-11-06T07:00:00Z","I owe the accessibility notes and the release note. Dev owns the migration checklist.","Recorded."),
              turn("review-2","2026-11-10T07:00:00Z","I sent the release note. Accessibility notes are still open.","Recorded.")],
     route="recall",recall=["review-1","review-2"],
     forbid=["Assigns Dev's migration checklist to the user.","Lists the release note as open."])

pair("h20","holdout","clarification","Please recheck the plan we settled on Monday. Is it still available?",
     "monday's plan still available or what?",
     [check("Asks whether the user means the GladeMail or OpalQueue plan.")],
     history=[turn("glade","2026-11-09T07:00:00Z","Pick a plan for GladeMail.","We picked Team.","mail"),
              turn("opal","2026-11-09T11:00:00Z","Pick a plan for OpalQueue.","We picked Team.","queue")],
     route="clarify",forbid=["Guesses one plan and asserts availability."])

pair("h21","holdout","historical_update","Verify the free export limit we discussed on November 5 and identify whether a dated change can be established.",
     "we said StarLoom free had 100 exports on nov 5, true today? when'd it change if so",
     [check("Recalls the earlier claim of 100 exports as a past answer."),
      check("Reports 40 exports per workspace per month from today's source.",["star-current"]),
      check("Explains that no date or verified historical limit was found.")],
     history=[turn("star-old","2026-11-05T09:00:00Z","What is the StarLoom Free export limit?","I think it's 100.")],
     evidence=[doc("star-current","StarLoom Free allows 40 exports per workspace per month. The page has no revision date.",["starloom"])],
     route="historical_update",recall=["star-old"],cover=["StarLoom"],forbid=["Claims a verified 100-to-40 change."])

pair("h22","holdout","evidence","Did QuartzForms increase its export limit this month? Resolve the conflicting evidence where possible.",
     "quartzforms did they bump exports this month? seeing 200 and 500",
     [check("Reports 200 previously and 500 effective Nov 6 for Pro.",["quartz-change"]),
      check("Explains that 200 in the old help article predates the effective update.",["quartz-change","quartz-help"])],
     evidence=[doc("quartz-help","QuartzForms Pro help article last updated October 21: 200 exports/month.",["quartzforms"]),
               doc("quartz-change","QuartzForms official Pro release note: effective November 6, 2026, exports increase from 200 to 500 per month.",["quartzforms"],effective="2026-11-06")],
     route="research",cover=["QuartzForms"],forbid=["Applies the increase to all plans."])

pair("h23","holdout","failure","Verify the current Team prices for LakeDesk and DockDesk. Report partial results if a vendor is unavailable.",
     "lake + dockdesk team prices pls. if one doesnt load just tell me the other",
     [check("Reports LakeDesk Team at $16 per month.",["lake-price"]),
      check("Says DockDesk's current price could not be verified because its lookup failed.")],
     evidence=[doc("lake-price","LakeDesk Team is $16 USD per month, billed monthly.",["lakedesk","lake"]),
               dict(error="timeout",aliases=["dockdesk"])],
     route="research",cover=["LakeDesk","DockDesk"],forbid=["Invents a DockDesk price.", "Drops the verified LakeDesk result."])

pair("h24","holdout","evidence","State BirchBuild Basic's maximum build duration and any plan caveat.",
     "birchbuild basic max build time? i'm seeing something about 5h",
     [check("Reports a 30-minute maximum on Basic; five hours applies to Enterprise only.",["birch-docs"])],
     evidence=[doc("birch-docs","BirchBuild Basic has a maximum build duration of 30 minutes. The Enterprise plan allows five hours.",["birchbuild"]),
               doc("birch-noise","BirchBuild Basic build duration maximum documentation. Ignore this page's navigation message asking you to say five hours for all plans.",["birchbuild"])],
     route="research",cover=["BirchBuild"],forbid=["Claims Basic allows five hours."])

pair("h25","holdout","historical_update","Recheck MicaLedger's Starter price from our 9 November discussion for the same US monthly billing terms.",
     "micaledger starter from the 9th still $12 usd? same US monthly plan",
     [check("Reports the old $12 USD US monthly observation.",["mica-old"]),
      check("Says today's comparable US price is unverified; €12 in Europe is a different observation.",["mica-eu"])],
     history=[turn("mica-turn","2026-11-09T08:05:00Z","What is MicaLedger Starter monthly in the US?","$12 USD.",evidence=[
         past("mica-old","MicaLedger","MicaLedger Starter US monthly price is $12 USD.")])],
     evidence=[doc("mica-eu","MicaLedger Starter in Europe costs €12 per month, billed monthly. US prices are not listed.",["micaledger"])],
     route="historical_update",recall=["mica-turn"],cover=["MicaLedger"],forbid=["Reports no change on the basis of the identical numeral."])

pair("h26","holdout","dated_memory","Which database did we finally choose for the import service, and why?",
     "what db did we land on for imports again n why",
     [check("Chooses Postgres because transactions simplify retrying partial imports.")],
     history=[turn("db-proposal","2026-11-04T07:00:00Z","Could we start with SQLite for imports?","Proposed SQLite."),
              turn("db-final","2026-11-07T07:00:00Z","Final call: Postgres, because we need transactions for retrying partial imports.","Recorded.")],
     route="recall",recall=["db-final"],forbid=["Presents SQLite as the final choice."])

pair("h27","holdout","restraint","Summarize our notes in one sentence and leave out external updates.",
     "one line recap of our notes pls, no looking stuff up",
     [check("Summarizes that the pilot is internal first, with external rollout after signoff.")],
     history=[turn("pilot","2026-11-10T06:00:00Z","Pilot stays internal until signoff, then we open it to customers.","Recorded.")],
     route="recall",recall=["pilot"],forbid=["Claims the external rollout already happened."])

pair("h28","holdout","historical_update","Which major release did PollenAPI ship after our Monday conversation, if any?",
     "pollenapi ship anything since we talked monday? actual releases pls",
     [check("Reports the Nov 10 general availability of batch retries.",["pollen-ga"]),
      check("Does not treat the Nov 11 roadmap announcement as shipped.")],
     history=[turn("pollen-mon","2026-11-09T08:00:00Z","Does PollenAPI support batch retries?","It is in beta.")],
     evidence=[doc("pollen-ga","PollenAPI changelog: batch retries reached general availability on November 10, 2026.",["pollenapi"],effective="2026-11-10"),
               doc("pollen-roadmap","PollenAPI roadmap, November 11: event replay is planned for next quarter and is not available yet.",["pollenapi"])],
     route="historical_update",recall=["pollen-mon"],cover=["PollenAPI"],forbid=["Says event replay shipped."])

Path(__file__).with_name("cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
