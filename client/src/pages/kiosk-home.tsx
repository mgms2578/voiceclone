import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Wifi, ArrowRight } from "lucide-react";

export default function KioskHomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center p-4">
      <div className="max-w-4xl w-full">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-6xl font-bold text-gray-800 mb-4">
            음성 클로닝 체험 키오스크
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            딥페이크 기술의 위험성을 체험하고 학습하세요
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {/* HTTP 다운로드 버전 */}
          <Card className="hover:shadow-xl transition-shadow duration-300">
            <CardHeader className="text-center pb-4">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Download className="w-8 h-8 text-blue-600" />
              </div>
              <CardTitle className="text-2xl text-gray-800">
                기본 버전
              </CardTitle>
              <p className="text-gray-600">
                HTTP 다운로드 방식 TTS
              </p>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-gray-600 mb-6 leading-relaxed">
                기존 방식의 음성 합성으로<br />
                안정적인 체험을 제공합니다
              </p>
              <Link href="/kiosk/download">
                <Button 
                  size="lg" 
                  className="w-full text-lg py-6"
                  data-testid="button-start-download"
                >
                  기본 버전 시작
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* WebSocket 스트리밍 버전 */}
          <Card className="hover:shadow-xl transition-shadow duration-300">
            <CardHeader className="text-center pb-4">
              <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Wifi className="w-8 h-8 text-purple-600" />
              </div>
              <CardTitle className="text-2xl text-gray-800">
                스트리밍 버전
              </CardTitle>
              <p className="text-gray-600">
                WebSocket 실시간 TTS
              </p>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-gray-600 mb-6 leading-relaxed">
                실시간 스트리밍 방식으로<br />
                더 빠른 응답을 제공합니다
              </p>
              <Link href="/kiosk/websocket">
                <Button 
                  size="lg" 
                  variant="outline"
                  className="w-full text-lg py-6 border-purple-200 text-purple-700 hover:bg-purple-50"
                  data-testid="button-start-websocket"
                >
                  스트리밍 버전 시작
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>

        <div className="text-center mt-12 text-sm text-gray-500">
          <p>두 버전은 동일한 기능을 제공하며, TTS 처리 방식만 다릅니다</p>
        </div>
      </div>
    </div>
  );
}