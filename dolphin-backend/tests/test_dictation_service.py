import unittest
from unittest.mock import patch

from app import dictation_service


class DictationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_empty_audio_before_contacting_worker(self):
        with self.assertRaises(dictation_service.DictationServiceError) as context:
            await dictation_service.transcribe_audio(
                b'',
                content_type='audio/webm',
                filename='dictation.webm',
                language=None,
            )
        self.assertEqual(context.exception.status_code, 400)

    async def test_rejects_oversized_audio_before_contacting_worker(self):
        with patch.object(dictation_service, 'MAX_AUDIO_BYTES', 4):
            with self.assertRaises(dictation_service.DictationServiceError) as context:
                await dictation_service.transcribe_audio(
                    b'12345',
                    content_type='audio/webm',
                    filename='dictation.webm',
                    language=None,
                )
        self.assertEqual(context.exception.status_code, 413)

    async def test_status_reports_an_unavailable_worker_without_raising(self):
        with patch.object(
            dictation_service,
            '_json_request',
            side_effect=dictation_service.DictationServiceError('offline', 503),
        ):
            status = await dictation_service.dictation_status()
        self.assertFalse(status['available'])
        self.assertEqual(status['detail'], 'offline')

    async def test_preview_mode_is_forwarded_to_the_worker(self):
        with patch.object(
            dictation_service,
            '_json_request',
            return_value={'text': 'live words'},
        ) as request:
            result = await dictation_service.transcribe_audio(
                b'webm audio',
                content_type='audio/webm',
                filename='dictation.webm',
                language=None,
                preview=True,
            )

        self.assertEqual(result['text'], 'live words')
        self.assertEqual(
            request.call_args.kwargs['headers']['X-Dictation-Mode'],
            'preview',
        )


if __name__ == '__main__':
    unittest.main()
