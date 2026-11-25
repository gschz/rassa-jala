import { Badge } from "@rassa-jala/ui/components/badge";
import { Bubble, BubbleContent } from "@rassa-jala/ui/components/bubble";
import { Button, buttonVariants } from "@rassa-jala/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rassa-jala/ui/components/dropdown-menu";
import { Checkbox } from "@rassa-jala/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rassa-jala/ui/components/dialog";
import { Input } from "@rassa-jala/ui/components/input";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@rassa-jala/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from "@rassa-jala/ui/components/message-scroller";
import { Skeleton } from "@rassa-jala/ui/components/skeleton";
import { cn } from "@rassa-jala/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  Check,
  CheckCheck,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  User,
  Users,
  ImageIcon,
  AudioLines,
  Video,
} from "lucide-react";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import type { MangoQuery } from "rxdb/plugins/core";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DividerFecha,
  DividerNoLeidos,
  diaMazatlan,
  guardarMarcaVisto,
  leerMarcaVisto,
} from "@/components/conversation-divider";
import { EmptyState } from "@/components/empty-state";
import { PageContainer, PageHeader } from "@/components/page-header";
import { useOnline } from "@/hooks/use-online";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { type MensajeDoc, type RassaDatabase } from "@/lib/rxdb/database";
import { eliminarBorradorLocal, eliminarMensajeFantasma } from "@/lib/rxdb/mensaje-eliminar";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { getServerUrl } from "@/lib/server-url";
import { subirArchivoChat, tipoMensajeDeAdjunto } from "@/lib/imagen-upload";
import { ProductImage } from "@/components/product-image";
import {
  conectarWs,
  desconectarWs,
  estadoWs,
  suscribirseEstadoWs,
  suscribirseWs,
  type EstadoWs,
} from "@/lib/ws-client";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P1-D Chat (docs/roadmap.md §6 P1-D; docs/database.md §3.6/§6.2 M-18). Design-system
 * compositions (PageHeader + Bubble + Card + Badge), semantic tokens only, Spanish
 * copy, no emojis as icons.
 *
 * Architecture (user decision 2026-11-20 — WS = NOTIFIER ONLY, S3 = source of truth):
 * - The conversation LIST is server-fetched (tRPC chat.listarConversaciones) with a
 *   45 s polling fallback whenever the socket is not connected.
 * - The timeline reads the S3 RxDB `mensajes` collection (offline-first). Sending
 *   ONLINE confirms via chat.enviar (operationId idempotent); OFFLINE it queues a
 *   local draft (syncOpId marker) that the mensajes push adjudicates on reconnect —
 *   drafts show "Pendiente de confirmación" (scope §6: never shown as confirmed).
 * - WS events only accelerate: invalidate the chat queries + reSync. Roles: any
 *   authenticated user (legacy IsAuthenticated parity); the server scopes the list
 *   and the timeline to the caller's integrantes rows.
 * - T17 (gap-pass-7): (a) the "Contactar" entry points (boton-contactar.tsx) land on
 *   /chat?conv=<id> — a PRIVATE 1:1 conversation from chat.iniciarPrivado, whose
 *   list row already shows the other member's name (server projection). (b) Image
 *   attachments are ONLINE-ONLY and ASYMMETRIC by design: the BYTES upload over
 *   HTTP (POST /upload/documentos), the MESSAGE (tipo "imagen" + archivoUrl) rides
 *   the normal enviar/push lanes — the file itself never enters any sync lane, and
 *   the offline draft queue stays TEXT-ONLY (the attach button disables offline).
 * - T5 (gap-pass-8): presentation-only chat UX — MessageScroller primitives
 *   (auto-follow only when parked at the bottom + jump-to-latest pill), date and
 *   unread dividers (conversation-divider.tsx; the unread marker is a cosmetic
 *   localStorage marker, server `leido` F13 stays the owner), bubble skeletons
 *   during the first RxDB load, and a mobile single-pane view (list OR window).
 */

export const Route = createFileRoute("/chat")({
  // T17: "Contactar" deep-link — ?conv pre-selects the conversation it opened.
  validateSearch: (search: Record<string, unknown>): { conv?: string } => ({
    conv: typeof search.conv === "string" ? search.conv : undefined,
  }),
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: ChatRoute,
});

type ConversacionDto = {
  id: string;
  tipo: "grupal" | "privada";
  nombre: string;
  esFamilia: boolean;
  /** T6 §7.21: manual group (grupal without familia) — rename/member UI applies. */
  manual: boolean;
  /** T6 §7.21: the caller is the group creator (integrantes.rol "admin"). */
  administrable: boolean;
  integrantes: Array<{ id: string; nombre: string; rol: string }>;
  ultimoMensaje: string | null;
  ultimoMensajeCreadoEn: string | null;
  noLeidos: number;
};

/** Local state mirror of the socket state (tiny external-store subscription). */
function useWsEstado(): EstadoWs {
  const [valor, setValor] = useState<EstadoWs>(() => estadoWs());
  useEffect(() => suscribirseEstadoWs(setValor), []);
  return valor;
}

function ChatRoute() {
  const db = useDatabase();
  const session = useSession();
  const repRef = useRef<ReplicationSet | null>(null);
  const queryClient = useQueryClient();
  const estadoSocket = useWsEstado();
  const isOnline = useOnline();
  // T17: ?conv= deep-link from the "Contactar" buttons pre-selects the conversation.
  const { conv } = Route.useSearch();
  const [seleccion, setSeleccion] = useState<string | null>(() => conv ?? null);

  // WS notifier connection lives for the whole authenticated app (login already
  // happened — the token exists; without it conectarWs stays disconnected).
  useEffect(() => {
    conectarWs();
    return () => desconectarWs();
  }, []);

  useEffect(() => {
    if (!db) return;
    const replications = startReplications(db);
    repRef.current = replications;
    return () => {
      void replications.stop();
      repRef.current = null;
    };
  }, [db]);

  // WS event → accelerate: invalidate the server-fetched list + reSync the S3
  // collection. (Polling keeps working whenever this does not arrive.)
  useEffect(() => {
    return suscribirseWs(() => {
      void queryClient.invalidateQueries({
        queryKey: trpc.chat.listarConversaciones.queryKey(),
      });
      repRef.current?.reSyncAll();
    });
  }, [queryClient]);

  // Polling fallback (45 s) whenever the WS notifier is not connected.
  const listado = useQuery(
    trpc.chat.listarConversaciones.queryOptions(undefined, {
      refetchInterval: estadoSocket === "conectado" ? false : 45_000,
    }),
  );

  if (!db) {
    return (
      <div className="flex h-full items-center justify-center pt-8">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Chat"
        description="Conversaciones de tu familia y grupos. Los mensajes se envían incluso sin conexión y se confirman al reconectar."
      />
      <div className="grid gap-4 md:grid-cols-[minmax(240px,320px)_1fr]">
        <ListaConversaciones
          conversaciones={listado.data ?? []}
          cargando={listado.isLoading}
          error={listado.error?.message ?? null}
          seleccion={seleccion}
          onSeleccion={setSeleccion}
          estadoSocket={estadoSocket}
          isOnline={isOnline}
        />
        <PanelConversacion
          db={db}
          repRef={repRef}
          conversacion={(listado.data ?? []).find((c) => c.id === seleccion) ?? null}
          idUsuario={session.user?.id ?? ""}
          isOnline={isOnline}
          onVolver={() => setSeleccion(null)}
        />
      </div>
    </PageContainer>
  );
}

function iniciales(nombre: string | null | undefined): string {
  if (!nombre) return "??";
  const partes = nombre.trim().split(/\s+/);
  if (partes.length >= 2) {
    return `${partes[0]?.[0] ?? ""}${partes[1]?.[0] ?? ""}`.toUpperCase();
  }
  return nombre.slice(0, 2).toUpperCase();
}

/**
 * T6 §7.21 group creation dialog: name + multi-select over the caller's CHAT GRAPH
 * contacts (chat.listarContactos — usuarios.list is Admin-only, documented cut).
 * ONLINE-ONLY: the button that opens it is disabled offline (conversaciones no se
 * replica — the new group exists only server-side until the next listarConversaciones).
 */
function DialogNuevoGrupo({
  abierto,
  onCambio,
  onCreada,
}: Readonly<{
  abierto: boolean;
  onCambio: (abierto: boolean) => void;
  onCreada?: (idConversacion: string) => void;
}>) {
  const contactos = useQuery(
    trpc.chat.listarContactos.queryOptions(undefined, { enabled: abierto }),
  );
  const [nombre, setNombre] = useState("");
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const crear = useMutation(
    trpc.chat.crearGrupo.mutationOptions({
      onSuccess: (data) => {
        toast.success("Grupo creado");
        setNombre("");
        setSeleccion(new Set());
        onCambio(false);
        onCreada?.(data.idConversacion);
      },
      onError: (error) => notificarError(error),
    }),
  );
  const alternar = (id: string, marcado: boolean): void => {
    setSeleccion((previo) => {
      const nuevo = new Set(previo);
      if (marcado) nuevo.add(id);
      else nuevo.delete(id);
      return nuevo;
    });
  };
  return (
    <Dialog
      open={abierto}
      onOpenChange={(abierto) => {
        onCambio(abierto);
        if (!abierto) setSeleccion(new Set());
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo grupo</DialogTitle>
          <DialogDescription>
            Elige un nombre y al menos un integrante. Aparecerás como creador del grupo.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={nombre}
          onChange={(event) => setNombre(event.target.value)}
          placeholder="Nombre del grupo"
          aria-label="Nombre del grupo"
          maxLength={100}
        />
        <div
          className="max-h-56 overflow-y-auto rounded-md border border-border/60"
          aria-label="Integrantes disponibles"
        >
          {contactos.isLoading && (
            <Loader2 className="mx-auto my-4 animate-spin text-muted-foreground" />
          )}
          {contactos.data?.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Aún no tienes contactos disponibles (personas de tus conversaciones o de tu familia).
            </p>
          )}
          {contactos.data?.map((contacto) => (
            <label
              key={contacto.id}
              className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/50"
            >
              <Checkbox
                checked={seleccion.has(contacto.id)}
                onCheckedChange={(marcado) => alternar(contacto.id, marcado === true)}
                aria-label={`Agregar a ${contacto.nombre}`}
              />
              <span className="flex-1 truncate text-xs">{contacto.nombre}</span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {contacto.rol}
              </Badge>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button
            disabled={!nombre.trim() || seleccion.size === 0 || crear.isPending}
            onClick={() => crear.mutate({ nombre: nombre.trim(), fkIntegrantes: [...seleccion] })}
          >
            {crear.isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            Crear grupo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** T6 §7.21 rename dialog — fresh state per mount (the Dialog unmounts on close). */
function DialogoRenombrar({
  conversacion,
  pendiente,
  onGuardar,
}: Readonly<{
  conversacion: ConversacionDto;
  pendiente: boolean;
  onGuardar: (nombre: string) => void;
}>) {
  const [nombre, setNombre] = useState(() => conversacion.nombre);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Renombrar conversación</DialogTitle>
        <DialogDescription>Solo el creador del grupo puede cambiar el nombre.</DialogDescription>
      </DialogHeader>
      <Input
        value={nombre}
        onChange={(event) => setNombre(event.target.value)}
        aria-label="Nuevo nombre"
        maxLength={100}
      />
      <DialogFooter>
        <Button
          disabled={!nombre?.trim() || nombre.trim() === conversacion.nombre || pendiente}
          onClick={() => onGuardar(nombre.trim())}
        >
          Guardar
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** T6 §7.21 members dialog — mounts fresh each open (contacts query runs on mount). */
function DialogoIntegrantes({
  conversacion,
  onAgregar,
  onQuitar,
  agregando,
  quitando,
}: Readonly<{
  conversacion: ConversacionDto;
  onAgregar: (usuarios: string[]) => void;
  onQuitar: (usuario: string) => void;
  agregando: boolean;
  quitando: boolean;
}>) {
  const contactos = useQuery(trpc.chat.listarContactos.queryOptions(undefined, {}));
  const miembros = new Set(conversacion.integrantes.map((i) => i.id));
  const porAgregar = (contactos.data ?? []).filter((c) => !miembros.has(c.id));
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Integrantes del grupo</DialogTitle>
        <DialogDescription>
          El creador del grupo no puede quitarse. Añade contactos de tus conversaciones o familia.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1" aria-label="Integrantes actuales">
        {conversacion.integrantes.map((integrante) => (
          <div key={integrante.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <span className="flex-1 truncate text-xs">{integrante.nombre}</span>
            {integrante.rol === "admin" ? (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                Creador
              </Badge>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:bg-destructive/10"
                aria-label={`Quitar a ${integrante.nombre}`}
                disabled={quitando}
                onClick={() => onQuitar(integrante.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1" aria-label="Contactos para agregar">
        <p className="text-[11px] font-medium text-muted-foreground">Agregar contactos</p>
        {contactos.isLoading && (
          <Loader2 className="mx-auto my-2 animate-spin text-muted-foreground" />
        )}
        {porAgregar.length === 0 && !contactos.isLoading && (
          <p className="text-xs text-muted-foreground">No hay contactos nuevos para agregar.</p>
        )}
        {porAgregar.map((contacto) => (
          <div key={contacto.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <span className="flex-1 truncate text-xs">{contacto.nombre}</span>
            <Button
              variant="outline"
              size="xs"
              disabled={agregando}
              aria-label={`Agregar a ${contacto.nombre}`}
              onClick={() => onAgregar([contacto.id])}
            >
              Agregar
            </Button>
          </div>
        ))}
      </div>
    </DialogContent>
  );
}

function ListaConversaciones({
  conversaciones,
  cargando,
  error,
  seleccion,
  onSeleccion,
  estadoSocket,
  isOnline,
}: Readonly<{
  conversaciones: ConversacionDto[];
  cargando: boolean;
  error: string | null;
  seleccion: string | null;
  onSeleccion: (id: string) => void;
  estadoSocket: EstadoWs;
  isOnline: boolean;
}>) {
  // T6 §7.21: manual group creation (online-only — conversaciones no se replica).
  const [grupoAbierto, setGrupoAbierto] = useState(false);
  // T5 (gap-pass-8) responsive: below md the view is list OR window (never
  // side-by-side) — hide the list while a conversation is open.
  return (
    <Card className={cn("self-start", seleccion && "hidden md:flex")}>
      <CardHeader>
        <CardTitle>Conversaciones</CardTitle>
        <CardDescription>
          {estadoSocket === "conectado" ? "En vivo" : "Sincronización cada 45 segundos"}
        </CardDescription>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={!isOnline}
          aria-label="Nuevo grupo"
          onClick={() => setGrupoAbierto(true)}
        >
          <Users data-icon="inline-start" />
          Nuevo grupo
        </Button>
        {!isOnline && (
          <span className="text-[11px] text-muted-foreground">Crear grupos requiere conexión.</span>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        <DialogNuevoGrupo
          abierto={grupoAbierto}
          onCambio={setGrupoAbierto}
          onCreada={onSeleccion}
        />
        {cargando && <Loader2 className="mx-auto my-4 animate-spin text-muted-foreground" />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!cargando && !error && conversaciones.length === 0 && (
          <EmptyState
            icon={<MessageSquare />}
            title="Sin conversaciones"
            description="Aún no participas en ninguna conversación."
          />
        )}
        {conversaciones.map((conv) => {
          const activa = seleccion === conv.id;
          return (
            <button
              key={conv.id}
              type="button"
              onClick={() => onSeleccion(conv.id)}
              aria-current={activa ? "true" : undefined}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-all outline-none",
                activa
                  ? "border-primary/50 bg-primary/10 shadow-xs"
                  : "border-transparent hover:border-border hover:bg-muted/50",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors",
                  activa
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground group-hover:bg-accent group-hover:text-accent-foreground",
                )}
                aria-hidden
              >
                {conv.esFamilia ? <Users className="size-4" /> : <User className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-xs font-semibold",
                      activa ? "text-primary" : "text-foreground",
                    )}
                  >
                    {conv.nombre}
                  </span>
                  {conv.noLeidos > 0 && (
                    <Badge variant="default" className="shrink-0 h-4.5 px-1.5 text-[10px]">
                      {conv.noLeidos}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {conv.ultimoMensaje ?? "Sin mensajes"}
                </p>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

const MENSAJES_QUERY: MangoQuery<MensajeDoc> = { sort: [{ creadoEn: "asc" }] };

/** Reports whether the scroller viewport is parked at (or near) the bottom. */
function VigiaFondo({ onCambio }: Readonly<{ onCambio: (alFondo: boolean) => void }>) {
  const scrollable = useMessageScrollerScrollable();
  const alFondo = !scrollable.end;
  useEffect(() => {
    onCambio(alFondo);
  }, [alFondo, onCambio]);
  return null;
}

const FILAS_SKELETON = [
  { propio: false, ancho: "w-3/5" },
  { propio: true, ancho: "w-1/2" },
  { propio: false, ancho: "w-2/3" },
  { propio: true, ancho: "w-2/5" },
] as const;

/** Bubble-shaped loading placeholders (gap-pass-8 T5) — alternating sides, 4 rows. */
function SkeletonChat() {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-3" aria-busy="true">
      {FILAS_SKELETON.map((fila, i) => (
        <div key={i} className={cn("flex", fila.propio ? "justify-end" : "justify-start")}>
          <Skeleton className={cn("h-9 rounded-2xl", fila.ancho)} />
        </div>
      ))}
    </div>
  );
}

function PanelConversacion({
  db,
  repRef,
  conversacion,
  idUsuario,
  isOnline,
  onVolver,
}: Readonly<{
  db: RassaDatabase;
  repRef: React.RefObject<ReplicationSet | null>;
  conversacion: ConversacionDto | null;
  idUsuario: string;
  isOnline: boolean;
  onVolver: () => void;
}>) {
  const queryClient = useQueryClient();
  const resincronizar = (): void => {
    void queryClient.invalidateQueries({
      queryKey: trpc.chat.listarConversaciones.queryKey(),
    });
    repRef.current?.reSyncAll();
  };

  if (!conversacion) {
    return (
      // T5 responsive: the placeholder only makes sense beside the list — on
      // mobile (list OR window) the list alone fills the view.
      <Card className="hidden md:flex">
        <CardContent className="py-12">
          <EmptyState
            icon={<MessageSquare />}
            title="Selecciona una conversación"
            description="Elige una conversación de la lista para ver sus mensajes."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <PanelAbierto
      key={conversacion.id}
      db={db}
      conversacion={conversacion}
      idUsuario={idUsuario}
      isOnline={isOnline}
      onVolver={onVolver}
      resincronizar={resincronizar}
    />
  );
}

function PanelAbierto({
  db,
  conversacion,
  idUsuario,
  isOnline,
  onVolver,
  resincronizar,
}: Readonly<{
  db: RassaDatabase;
  conversacion: ConversacionDto;
  idUsuario: string;
  isOnline: boolean;
  onVolver: () => void;
  resincronizar: () => void;
}>) {
  // The selector is fixed per panel instance (keyed by conversation id), so the live
  // query object is built once and never resubscribes.
  const [queryMensajes] = useState<MangoQuery<MensajeDoc>>(() => ({
    ...MENSAJES_QUERY,
    selector: { fkConversacion: conversacion.id },
  }));
  const mensajes = useRxQueryLive<MensajeDoc>({
    collection: db.mensajes,
    query: queryMensajes,
  });
  const docsMensajes = mensajes.results.map((doc) => doc.toJSON() as MensajeDoc);

  // T5 (gap-pass-8): client-side seen marker, COSMETIC only — the server `leido`
  // (F13, monotonic) keeps owning read state. The threshold is frozen at open so
  // the unread divider keeps marking THIS session's novelty; the localStorage
  // marker updates when the panel is open and parked at the bottom (the next
  // open then starts after those messages).
  const [vistoHasta] = useState<string | null>(() => leerMarcaVisto(conversacion.id));
  const primerNoVisto = vistoHasta
    ? docsMensajes.findIndex((m) => m.fkAutor !== idUsuario && m.creadoEn > vistoHasta)
    : -1;
  const noVistos =
    vistoHasta === null
      ? 0
      : docsMensajes.filter((m) => m.fkAutor !== idUsuario && m.creadoEn > vistoHasta).length;

  // At-bottom tracking (the scroller primitive reports "end" = AWAY from the
  // bottom): drives the marker save and the "N nuevos" counter on the
  // jump-to-latest pill.
  const [alFondo, setAlFondo] = useState(true);
  const [nuevosNoFondo, setNuevosNoFondo] = useState(0);
  const lenPrevio = useRef(docsMensajes.length);
  useEffect(() => {
    const len = docsMensajes.length;
    const delta = len - lenPrevio.current;
    lenPrevio.current = len;
    if (alFondo) {
      setNuevosNoFondo(0);
      return;
    }
    if (delta > 0) {
      const entrantes = docsMensajes
        .slice(len - delta)
        .filter((m) => m.fkAutor !== idUsuario).length;
      setNuevosNoFondo((n) => n + entrantes);
    }
  }, [alFondo, docsMensajes, idUsuario]);

  const marcaGuardada = useRef<string | null>(null);
  useEffect(() => {
    if (!alFondo || docsMensajes.length === 0) return;
    const ultima = docsMensajes[docsMensajes.length - 1]?.creadoEn;
    if (!ultima || marcaGuardada.current === ultima) return;
    marcaGuardada.current = ultima;
    guardarMarcaVisto(conversacion.id, ultima);
  }, [alFondo, docsMensajes, conversacion.id]);

  const [mensajeAEliminar, setMensajeAEliminar] = useState<string | null>(null);
  // T6 §7.21 group management dialogs (creator-only surface; the server re-checks).
  const [dialogoGrupo, setDialogoGrupo] = useState<"renombrar" | "integrantes" | null>(null);

  const marcar = useMutation(
    trpc.chat.marcarLeido.mutationOptions({
      onSuccess: () => resincronizar(),
      onError: (error) => notificarError(error),
    }),
  );
  const enviar = useMutation(
    trpc.chat.enviar.mutationOptions({
      onSuccess: () => resincronizar(),
      onError: (error) => notificarError(error),
    }),
  );
  const editar = useMutation(
    trpc.chat.editar.mutationOptions({
      onSuccess: () => {
        toast.success("Mensaje editado");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const eliminar = useMutation(
    trpc.chat.eliminar.mutationOptions({
      onSuccess: () => {
        toast.success("Mensaje eliminado");
        resincronizar();
      },
      onError: async (error, variables) => {
        if (error.data?.code === "NOT_FOUND") {
          // C2: NOT_FOUND means the server row does not exist (lost/rejected
          // create or a server DB restore): the local doc is a ghost. Remove it
          // so it stops rendering and the retry stops erroring forever; the
          // push lane's rechazada verdict is the visible server answer.
          if (await eliminarMensajeFantasma(db, variables.id)) {
            toast.info("El mensaje ya no existe en el servidor. Se quitó de tu lista.");
            return;
          }
        }
        notificarError(error);
      },
    }),
  );

  // T6 §7.21 group management (creator/online-only lanes; server re-checks the guard).
  const renombrar = useMutation(
    trpc.chat.renombrarConversacion.mutationOptions({
      onSuccess: () => {
        toast.success("Conversación renombrada");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const agregarIntegrantes = useMutation(
    trpc.chat.agregarIntegrantes.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.agregados === 1 ? "Integrante agregado" : "Integrantes agregados");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const quitarIntegrante = useMutation(
    trpc.chat.quitarIntegrante.mutationOptions({
      onSuccess: () => {
        toast.success("Integrante quitado");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  // Mark read once per conversation open (legacy bulk PATCH parity).
  const leidoSolicitado = useRef(false);
  const noLeidos = conversacion.noLeidos;
  useEffect(() => {
    if (leidoSolicitado.current || noLeidos === 0) return;
    leidoSolicitado.current = true;
    marcar.mutate({ fkConversacion: conversacion.id, operationId: crypto.randomUUID() });
  }, [noLeidos]);

  return (
    <Card className="flex h-[calc(100vh-14rem)] min-h-120 flex-col">
      <CardHeader className="border-b border-border/60 pb-3">
        <div className="flex items-center gap-2.5">
          {/* T5 responsive: back to the conversation list (mobile single-pane view). */}
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Volver a conversaciones"
            onClick={onVolver}
          >
            <ArrowLeftIcon />
          </Button>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {conversacion.esFamilia ? <Users className="size-4" /> : <User className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle>{conversacion.nombre}</CardTitle>
            <CardDescription>
              {conversacion.esFamilia
                ? "Grupo familiar"
                : conversacion.tipo === "grupal"
                  ? "Grupo"
                  : "Conversación privada"}
            </CardDescription>
          </div>
          {/* T6 §7.21: creator-only management surface (server guard re-checks).
              Manual groups only — family chats are family-administered. */}
          {conversacion.manual && conversacion.administrable && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Renombrar conversación"
                disabled={!isOnline}
                onClick={() => setDialogoGrupo("renombrar")}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Administrar integrantes"
                disabled={!isOnline}
                onClick={() => setDialogoGrupo("integrantes")}
              >
                <Users />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {mensajes.loading ? (
          <SkeletonChat />
        ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport aria-label="Mensajes de la conversación">
                <MessageScrollerContent className="gap-3">
                  {docsMensajes.map((mensaje, indice) => {
                    const previo = indice > 0 ? docsMensajes[indice - 1] : undefined;
                    const cambiaDia =
                      previo === undefined ||
                      diaMazatlan(mensaje.creadoEn) !== diaMazatlan(previo.creadoEn);
                    return (
                      <Fragment key={mensaje.id}>
                        {cambiaDia && (
                          <MessageScrollerItem className="py-1">
                            <DividerFecha creadoEn={mensaje.creadoEn} ahora={Date.now()} />
                          </MessageScrollerItem>
                        )}
                        {indice === primerNoVisto && (
                          <MessageScrollerItem className="py-1">
                            <DividerNoLeidos cantidad={noVistos} />
                          </MessageScrollerItem>
                        )}
                        <MessageScrollerItem
                          messageId={mensaje.id}
                          scrollAnchor={mensaje.fkAutor === idUsuario}
                        >
                          <FilaMensaje
                            mensaje={mensaje}
                            propio={mensaje.fkAutor === idUsuario}
                            isOnline={isOnline}
                            onEditar={(contenido) =>
                              editar.mutate({
                                id: mensaje.id,
                                contenido,
                                operationId: crypto.randomUUID(),
                              })
                            }
                            onSolicitarEliminar={() => setMensajeAEliminar(mensaje.id)}
                          />
                        </MessageScrollerItem>
                      </Fragment>
                    );
                  })}
                  {docsMensajes.length === 0 && (
                    <MessageScrollerItem>
                      <div className="flex flex-col items-center py-12 text-center text-xs text-muted-foreground">
                        <MessageSquare className="mb-2 size-8 stroke-1 text-muted-foreground/60" />
                        <p className="font-medium">Sin mensajes todavía</p>
                        <p>Escribe el primer mensaje para iniciar la conversación.</p>
                      </div>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              {/* Jump-to-latest: the primitive shows it only when away from the
                  bottom and scrolls back smoothly; autoScroll never hijacks the
                  scroll position once the user scrolled up to read. */}
              <MessageScrollerButton
                render={<Button variant="secondary" size="sm" aria-label="Ir al último mensaje" />}
              >
                <ArrowDownIcon data-icon="inline-start" />
                {nuevosNoFondo > 0 && (
                  <span className="text-xs font-medium">
                    {nuevosNoFondo === 1 ? "1 nuevo" : `${nuevosNoFondo} nuevos`}
                  </span>
                )}
              </MessageScrollerButton>
            </MessageScroller>
            <VigiaFondo onCambio={setAlFondo} />
          </MessageScrollerProvider>
        )}
        <FormularioEnvio
          isOnline={isOnline}
          enviando={enviar.isPending}
          onEnviar={(contenido) => {
            if (isOnline) {
              enviar.mutate({
                fkConversacion: conversacion.id,
                contenido,
                operationId: crypto.randomUUID(),
              });
              return;
            }
            // Offline queue: a local draft with its idempotency key; the mensajes
            // push adjudicates it on reconnect (never shown as confirmed before).
            // TEXT-ONLY: attachments need the online upload — no imagen drafts.
            const borrador: MensajeDoc = {
              id: crypto.randomUUID(),
              fkConversacion: conversacion.id,
              fkAutor: idUsuario,
              autorNombre: null,
              contenido,
              tipo: "texto",
              archivoUrl: null,
              leido: false,
              editado: false,
              estado: true,
              version: 0,
              creadoEn: new Date().toISOString(),
              actualizadoEn: new Date().toISOString(),
              syncOpId: crypto.randomUUID(),
            };
            void db.mensajes.insert(borrador);
          }}
          onEnviarAdjunto={(archivoUrl, tipo, texto) => {
            // T17/T6: ONLINE-ONLY (the attach button is disabled offline). The
            // message rides the same idempotent enviar lane; the caption is optional.
            enviar.mutate({
              fkConversacion: conversacion.id,
              contenido: texto || undefined,
              tipo,
              archivoUrl,
              operationId: crypto.randomUUID(),
            });
          }}
        />
      </CardContent>

      {/* T6 §7.21: rename dialog (creator-only, manual groups). */}
      <Dialog
        open={dialogoGrupo === "renombrar"}
        onOpenChange={(abierto) => {
          if (!abierto) setDialogoGrupo(null);
        }}
      >
        <DialogoRenombrar
          conversacion={conversacion}
          pendiente={renombrar.isPending}
          onGuardar={(nombre) => renombrar.mutate({ id: conversacion.id, nombre })}
        />
      </Dialog>

      {/* T6 §7.21: members dialog — remove existing (except the creator) + add
          contacts not yet members. Both lanes are creator-only, online-only. */}
      <Dialog
        open={dialogoGrupo === "integrantes"}
        onOpenChange={(abierto) => {
          if (!abierto) setDialogoGrupo(null);
        }}
      >
        <DialogoIntegrantes
          conversacion={conversacion}
          onAgregar={(usuarios) => agregarIntegrantes.mutate({ id: conversacion.id, usuarios })}
          onQuitar={(usuario) =>
            quitarIntegrante.mutate({ id: conversacion.id, usuarios: [usuario] })
          }
          agregando={agregarIntegrantes.isPending}
          quitando={quitarIntegrante.isPending}
        />
      </Dialog>

      <ConfirmDialog
        open={mensajeAEliminar != null}
        onOpenChange={(open) => {
          if (!open) setMensajeAEliminar(null);
        }}
        title="¿Eliminar este mensaje?"
        description="Solo puedes eliminar mensajes dentro de los primeros 15 minutos de haberlos enviado. Esta acción no se puede revertir."
        confirmLabel="Eliminar mensaje"
        destructive
        onConfirm={() => {
          if (mensajeAEliminar) {
            const id = mensajeAEliminar;
            setMensajeAEliminar(null);
            // C2: a draft the server never confirmed (syncOpId) exists ONLY
            // locally — the online eliminar lane would answer NOT_FOUND forever.
            // Resolve the orphan locally: the push carries the delete and a
            // server that never saw the row settles it rechazada + tombstone.
            void eliminarBorradorLocal(db, id).then((eliminado) => {
              if (eliminado) {
                toast.success("Mensaje eliminado");
                return;
              }
              eliminar.mutate({ id, operationId: crypto.randomUUID() });
            });
          }
        }}
      />
    </Card>
  );
}

function FilaMensaje({
  mensaje,
  propio,
  isOnline,
  onEditar,
  onSolicitarEliminar,
}: Readonly<{
  mensaje: MensajeDoc;
  propio: boolean;
  isOnline: boolean;
  onEditar: (contenido: string) => void;
  onSolicitarEliminar: () => void;
}>) {
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState("");
  // The 15-min window (M-18): the actions hide after it; the server re-checks.
  const enVentana = Date.now() - new Date(mensaje.creadoEn).getTime() <= 15 * 60 * 1000;
  const pendiente = mensaje.syncOpId != null;

  if (editando) {
    return (
      <form
        className="flex items-center gap-2 rounded-lg border border-border bg-card/60 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const contenido = borrador.trim();
          if (!contenido || !isOnline) return;
          onEditar(contenido);
          setEditando(false);
        }}
      >
        <Input
          value={borrador}
          onChange={(event) => setBorrador(event.target.value)}
          aria-label="Editar mensaje"
          className="h-8"
        />
        <Button type="submit" size="xs" disabled={!borrador.trim() || !isOnline}>
          Guardar
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => setEditando(false)}>
          Cancelar
        </Button>
      </form>
    );
  }

  return (
    <Message align={propio ? "end" : "start"} className="group/message">
      {!propio && (
        <MessageAvatar className="mb-1 size-7 shrink-0 self-end bg-muted text-[10px] font-semibold text-muted-foreground">
          {iniciales(mensaje.autorNombre)}
        </MessageAvatar>
      )}
      <MessageContent className={propio ? "items-end" : "items-start"}>
        {!propio && (
          <MessageHeader className="mb-0.5 px-1 text-[11px] font-medium text-muted-foreground">
            {mensaje.autorNombre ?? "Sistema"}
          </MessageHeader>
        )}
        <div className="flex max-w-[85%] items-end gap-1.5">
          {propio && enVentana && isOnline && (
            <div className="flex items-center gap-0.5 self-center pb-1 opacity-0 transition-opacity group-hover/message:opacity-100">
              {!pendiente && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Editar mensaje"
                  onClick={() => {
                    setBorrador(mensaje.contenido ?? "");
                    setEditando(true);
                  }}
                >
                  <Pencil className="size-3" />
                </Button>
              )}
              {/* C2: a pending draft (syncOpId) is only deletable locally — the
                  online edit lane requires a server row that does not exist yet. */}
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:bg-destructive/10"
                aria-label="Eliminar mensaje"
                onClick={onSolicitarEliminar}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          )}
          <Bubble align={propio ? "end" : "start"} variant={propio ? "default" : "outline"}>
            <BubbleContent
              className={cn(
                "min-w-28 px-3.5 py-2 text-xs",
                propio
                  ? "bg-primary text-primary-foreground"
                  : "border-border bg-card text-card-foreground shadow-xs",
              )}
            >
              {/* T17: image messages render the attachment with the ProductImage
                  fallback pattern (placeholder on 404/missing), text below if any.
                  T6: audio/video messages render native players with the same
                  missing-file fallback (archivoUrl is a /storage/... reference). */}
              {mensaje.tipo === "imagen" && (
                <ProductImage
                  src={mensaje.archivoUrl ? `${getServerUrl()}${mensaje.archivoUrl}` : null}
                  alt="Imagen adjunta"
                  className="mb-1 h-44 w-64 rounded-md object-cover"
                />
              )}
              {mensaje.tipo === "audio" &&
                (mensaje.archivoUrl ? (
                  <audio
                    controls
                    preload="metadata"
                    src={`${getServerUrl()}${mensaje.archivoUrl}`}
                    className="mb-1 w-60"
                    aria-label="Audio adjunto"
                  />
                ) : (
                  <p className="text-xs italic opacity-75">Audio no disponible</p>
                ))}
              {mensaje.tipo === "video" &&
                (mensaje.archivoUrl ? (
                  <video
                    controls
                    preload="metadata"
                    src={`${getServerUrl()}${mensaje.archivoUrl}`}
                    className="mb-1 w-60 rounded-md"
                    aria-label="Video adjunto"
                  />
                ) : (
                  <p className="text-xs italic opacity-75">Video no disponible</p>
                ))}
              {mensaje.contenido && (
                <p className="leading-relaxed wrap-break-word">{mensaje.contenido}</p>
              )}
              <div
                className={cn(
                  "mt-1 flex items-center justify-end gap-1.5 text-[10px]",
                  propio ? "text-primary-foreground/75" : "text-muted-foreground",
                )}
              >
                {pendiente && <span>Pendiente</span>}
                {mensaje.editado && <span>editado</span>}
                <span>
                  {new Date(mensaje.creadoEn).toLocaleTimeString("es-MX", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {propio &&
                  (pendiente ? <Check className="size-3" /> : <CheckCheck className="size-3" />)}
              </div>
            </BubbleContent>
          </Bubble>
        </div>
      </MessageContent>
    </Message>
  );
}

function FormularioEnvio({
  isOnline,
  enviando,
  onEnviar,
  onEnviarAdjunto,
}: Readonly<{
  isOnline: boolean;
  enviando: boolean;
  onEnviar: (contenido: string) => void;
  onEnviarAdjunto: (archivoUrl: string, tipo: "imagen" | "audio" | "video", texto: string) => void;
}>) {
  const [contenido, setContenido] = useState("");
  // T17/T6: ONLINE-ONLY attachment (upload requires the server; the offline draft
  // queue is text-only). Picking a file uploads it FIRST, then sends the message
  // with the current input text as its optional caption; the picked file's MIME
  // decides the mensaje tipo (imagen|audio|video).
  const [subiendo, setSubiendo] = useState(false);
  const inputArchivoRef = useRef<HTMLInputElement | null>(null);
  const archivoPendiente = useRef<File | null>(null);

  const subirYEnviar = async (): Promise<void> => {
    const archivo = archivoPendiente.current;
    archivoPendiente.current = null;
    if (!archivo) return;
    const tipo = tipoMensajeDeAdjunto(archivo);
    if (tipo == null) {
      toast.error("Formato no permitido: usa imagen (PNG, JPG, WebP), audio o video");
      return;
    }
    setSubiendo(true);
    try {
      const adjunto = await subirArchivoChat(archivo);
      onEnviarAdjunto(adjunto.url, tipo, contenido.trim());
      setContenido("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo adjuntar el archivo.");
    } finally {
      setSubiendo(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5 border-t border-border/60 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        const texto = contenido.trim();
        if (!texto) return;
        onEnviar(texto);
        setContenido("");
      }}
    >
      {/* Hidden picker: the attach MENU drives it with a per-type accept; the
          selection resets the input so picking the SAME file twice still fires
          onChange. */}
      <input
        ref={inputArchivoRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,video/mp4,audio/ogg,audio/webm,video/quicktime"
        className="hidden"
        aria-label="Seleccionar imagen, audio o video para adjuntar"
        onChange={(event) => {
          archivoPendiente.current = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (archivoPendiente.current) void subirYEnviar();
        }}
      />
      <div className="relative flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            type="button"
            disabled={!isOnline || subiendo}
            aria-label="Adjuntar imagen, audio o video"
            className={cn(buttonVariants({ variant: "ghost", size: "icon-lg" }))}
          >
            {subiendo ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Paperclip className="size-4" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem
              onClick={() => {
                inputArchivoRef.current!.accept = "image/png,image/jpeg,image/webp";
                inputArchivoRef.current?.click();
              }}
            >
              <ImageIcon className="size-4" /> Foto
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                inputArchivoRef.current!.accept =
                  "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/webm";
                inputArchivoRef.current?.click();
              }}
            >
              <AudioLines className="size-4" /> Audio
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                inputArchivoRef.current!.accept = "video/mp4,video/webm,video/quicktime";
                inputArchivoRef.current?.click();
              }}
            >
              <Video className="size-4" /> Video
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          value={contenido}
          onChange={(event) => setContenido(event.target.value)}
          placeholder="Escribe un mensaje…"
          aria-label="Escribe un mensaje"
          className="h-10 flex-1"
        />
        <Button
          type="submit"
          size="icon-lg"
          disabled={!contenido.trim() || enviando || subiendo}
          aria-label="Enviar mensaje"
        >
          {enviando ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
      {!isOnline && (
        <span className="px-1 text-[11px] text-muted-foreground">
          Sin conexión: el mensaje se guardará localmente y se confirmará al reconectar. Los
          adjuntos de imagen, audio y video requieren conexión.
        </span>
      )}
    </form>
  );
}
