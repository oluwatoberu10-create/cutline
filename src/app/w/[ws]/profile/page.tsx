import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Card, CardBody, PageHeader } from "@/components/ui/kit";
import { saveProfileAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { getProfile } from "@/server/services/workspaces";
import { can } from "@/server/tenancy";

export const metadata = { title: "Creator profile" };

export default async function Profile({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await pageWs((await params).ws);
  const p = await getProfile(ws);
  const ro = !can(ws.role, "edit");
  const lines = (a: string[]) => a.join("\n");
  return (
    <>
      <PageHeader title="Creator profile" description="Everything the agent should know about this creator. Used for channel analysis, idea generation and metadata — and never shared with any other workspace." />
      <Card className="max-w-4xl"><CardBody>
        <ActionForm action={saveProfileAction} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="ws" value={ws.workspaceId} />
          <fieldset disabled={ro} className="contents">
            <Field label="Channel niche" htmlFor="niche"><Input id="niche" name="niche" defaultValue={p.niche} /></Field>
            <Field label="Target audience" htmlFor="ta"><Input id="ta" name="targetAudience" defaultValue={p.targetAudience} /></Field>
            <Field label="Audience problems" htmlFor="ap" hint="One per line"><Textarea id="ap" name="audienceProblems" rows={3} defaultValue={lines(p.audienceProblems)} /></Field>
            <Field label="Audience interests" htmlFor="ai" hint="One per line"><Textarea id="ai" name="audienceInterests" rows={3} defaultValue={lines(p.audienceInterests)} /></Field>
            <Field label="Content formats" htmlFor="fm" hint="tutorials, commentary, vlogs, interviews, reviews, documentaries…"><Textarea id="fm" name="formats" rows={2} defaultValue={lines(p.formats)} /></Field>
            <Field label="Existing content categories" htmlFor="cc" hint="One per line"><Textarea id="cc" name="contentCategories" rows={2} defaultValue={lines(p.contentCategories)} /></Field>
            <div className="grid grid-cols-2 gap-3"><Field label="Preferred length min (minutes)" htmlFor="lmin"><Input id="lmin" name="preferredLengthMin" type="number" min={0} defaultValue={p.preferredLengthMin ?? ""} /></Field><Field label="max" htmlFor="lmax"><Input id="lmax" name="preferredLengthMax" type="number" min={0} defaultValue={p.preferredLengthMax ?? ""} /></Field></div>
            <Field label="Publishing frequency" htmlFor="pf"><Input id="pf" name="publishingFrequency" defaultValue={p.publishingFrequency} /></Field>
            <Field label="Tone and personality" htmlFor="tone"><Input id="tone" name="tone" defaultValue={p.tone} /></Field>
            <Field label="Brand voice" htmlFor="bv"><Input id="bv" name="brandVoice" defaultValue={p.brandVoice} /></Field>
            <Field label="Content goals" htmlFor="goals" className="sm:col-span-2"><Textarea id="goals" name="goals" rows={2} defaultValue={p.goals} /></Field>
            <Field label="Topics to avoid" htmlFor="av" hint="One per line"><Textarea id="av" name="avoidTopics" rows={2} defaultValue={lines(p.avoidTopics)} /></Field>
            <Field label="Competitor channels" htmlFor="comp" hint="URLs or names, one per line"><Textarea id="comp" name="competitorChannels" rows={2} defaultValue={lines(p.competitorChannels)} /></Field>
            <Field label="Saved preferences" htmlFor="sp" className="sm:col-span-2" hint="Explicit rules the agent must follow for this creator, one per line (e.g. “never use clickbait titles”)."><Textarea id="sp" name="savedPreferences" rows={3} defaultValue={lines(p.savedPreferences)} /></Field>
            {!ro && <div className="sm:col-span-2"><SubmitButton>Save profile</SubmitButton></div>}
          </fieldset>
        </ActionForm>
      </CardBody></Card>
    </>
  );
}
