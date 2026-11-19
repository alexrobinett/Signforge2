import {
  CalendarClockIcon,
  ImagesIcon,
  LayersIcon,
  LayoutDashboardIcon,
  ListVideoIcon,
  MonitorIcon,
  PlugIcon,
  SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export interface Section {
  to: '/' | '/screens' | '/spots' | '/playlists' | '/schedule' | '/assets' | '/integrations' | '/settings';
  label: string;
  icon: LucideIcon;
  description: string;
  empty: { title: string; body: string };
}

/** The dashboard's navigation, in order. */
export const SECTIONS: Section[] = [
  {
    to: '/',
    label: 'Overview',
    icon: LayoutDashboardIcon,
    description: 'Your organization at a glance.',
    empty: { title: '', body: '' },
  },
  {
    to: '/screens',
    label: 'Screens',
    icon: MonitorIcon,
    description: 'The displays that play your content, and whether each is online and up to date.',
    empty: { title: 'No screens yet', body: 'Paired screens will appear here with their status, the content they are playing and when they last checked in.' },
  },
  {
    to: '/spots',
    label: 'Spots',
    icon: LayersIcon,
    description: 'The pieces of content a screen shows: templates filled with your text, images, video or a web page.',
    empty: { title: 'No spots yet', body: 'Spots you create from templates, images, video or web pages will be listed here.' },
  },
  {
    to: '/playlists',
    label: 'Playlists',
    icon: ListVideoIcon,
    description: 'Ordered spots that play in a loop.',
    empty: { title: 'No playlists yet', body: 'Playlists put spots in order and set how long each one plays.' },
  },
  {
    to: '/schedule',
    label: 'Schedule',
    icon: CalendarClockIcon,
    description: 'Which playlist plays on which screens, and when.',
    empty: { title: 'Nothing scheduled', body: 'Schedule entries choose a playlist by screen, day and time of day.' },
  },
  {
    to: '/assets',
    label: 'Assets',
    icon: ImagesIcon,
    description: 'Images and video uploaded for your spots.',
    empty: { title: 'No assets yet', body: 'Uploaded images and video, checked for the screens they will play on, will be kept here.' },
  },
  {
    to: '/integrations',
    label: 'Integrations',
    icon: PlugIcon,
    description:
      'Data reaches screens through our server, never directly: each source is fetched, checked and baked into the next version, so screens keep the last good copy when a source is down.',
    empty: { title: 'No data sources yet', body: 'Feeds, calendars and weather your spots read will be listed here with their health.' },
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    description: "Your organization's defaults, members and alerts.",
    empty: { title: '', body: '' },
  },
];

export const sectionFor = (to: Section['to']) => SECTIONS.find((s) => s.to === to)!;
