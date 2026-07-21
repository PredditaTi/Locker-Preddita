import React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CircleCheckBig,
  CircleHelp,
  Clock3,
  Delete,
  DoorOpen,
  House,
  LoaderCircle,
  PackageOpen,
  PackagePlus,
  QrCode,
  ShieldCheck,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

const DEFAULT_ICON_PROPS = {
  'aria-hidden': true,
  focusable: 'false',
  strokeWidth: 2.2,
};

export function KioskIcon({ icon: Icon, ...props }) {
  return <Icon {...DEFAULT_ICON_PROPS} {...props} />;
}

export const KioskIcons = {
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  camera: Camera,
  check: CircleCheckBig,
  close: X,
  clock: Clock3,
  courier: PackagePlus,
  delete: Delete,
  door: DoorOpen,
  help: CircleHelp,
  home: House,
  loading: LoaderCircle,
  qr: QrCode,
  resident: PackageOpen,
  shield: ShieldCheck,
  warning: TriangleAlert,
  volume: Volume2,
  volumeMuted: VolumeX,
};
