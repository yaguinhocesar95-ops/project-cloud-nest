import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AUDIT_KEY, emitCloudPull } from "@/lib/cloud-keys";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** Zera todas as apostas, o registro de rodadas e o histórico diário. Banca e ajustes ficam. */
export function ResetAllButton({ onClearBets, userId }: { onClearBets: () => void; userId: string | null }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      onClearBets();
      localStorage.setItem(AUDIT_KEY, "[]");
      emitCloudPull(AUDIT_KEY);
      if (userId) {
        await supabase.from("user_kv").upsert(
          { user_id: userId, key: AUDIT_KEY, value: [] as never, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" },
        );
        await supabase.from("daily_stats").delete().eq("user_id", userId);
      }
      toast.success("Resultados zerados. Começando do zero.");
    } catch {
      toast.error("Não foi possível zerar tudo. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-destructive/40 px-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden /> Zerar todos os resultados
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Zerar todos os resultados?</AlertDialogTitle>
          <AlertDialogDescription>
            Apaga todas as apostas (Supremo e outras trilhas), estrelinhas, erros, lucro e o histórico diário.
            Sua banca e seus ajustes continuam. Não dá para desfazer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => void run()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Zerar tudo
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
