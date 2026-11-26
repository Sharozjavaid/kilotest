import { useLocalSearchParams } from 'expo-router';
import { Placeholder } from '@/components/Placeholder';

/** Placeholder: a video's B-roll bin (mock-up `Broll`), built by the next mobile engineer. Param `id` is the video id. */
export default function BrollScreen() {
  useLocalSearchParams<{ id: string }>();
  return <Placeholder title="B-roll" icon="broll" body="Add product shots and cutaways to this video. Kilo places them against what you say." />;
}
